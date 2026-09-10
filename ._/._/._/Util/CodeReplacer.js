// CodeReplacer.js
import { readFile, writeFile } from 'fs/promises';

export class CodeReplacer {
  // Static buffer for incomplete tag input
  static tagBuffer = '';

  // Debug flag (enabled via CLI --debug / -d, or CodeReplacer.debug = true)
  static debug = false;

  /**
   * Emit a debug line when debug mode is on.
   * Never throws, never alters control flow.
   */
  static _dbg(...args) {
    if (CodeReplacer.debug) {
      console.error('[DEBUG]', ...args);
    }
  }

  /**
   * Detect whether a string uses ESCAPED line separators ("\r\n", "\n", "\r"
   * as visible backslash sequences) instead of real line breaks.
   *
   * Heuristic: contains the two-char sequence "\\n" AND has no real "\n".
   * This is deliberately conservative — strings with a mix are assumed to
   * be real (mixed content is almost always real source that happens to
   * contain a literal "\n" inside a JS string).
   */
  static _usesEscapedNewlines(s) {
    if (typeof s !== 'string' || s.length === 0) return false;
    return (s.includes('\\n') || s.includes('\\r')) && !s.includes('\n') && !s.includes('\r');
  }

  /**
   * Convert escaped line separators into real ones.
   * ONLY call this when `_usesEscapedNewlines(s)` returned true.
   * Handles the three escape forms; leaves every other escape (\t, \\, \xNN…)
   * untouched so source code inside strings is not corrupted.
   */
  static _unescapeLineSeparators(s) {
    if (typeof s !== 'string') return s;
    return s
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g,   '\n')
      .replace(/\\r/g,   '\n');
  }

  /**
   * Normalize real CRLF / CR line endings to LF (pure byte-level fix).
   * Never touches literal backslash sequences.
   */
  static _normalizeRealNewlines(s) {
    if (typeof s !== 'string') return s;
    return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  /**
   * Prepare the NEEDLE for matching against the (LF-normalized) file.
   * 1. If the needle uses escaped newlines, unescape them.
   * 2. Collapse real CRLF/CR to LF.
   * 3. Strip one optional leading newline and one optional trailing newline,
   *    because the block syntax tends to capture one on each side and the
   *    surrounding file rarely has them exactly.
   */
  static _prepareNeedle(s) {
    let out = s;
    if (CodeReplacer._usesEscapedNewlines(out)) {
      out = CodeReplacer._unescapeLineSeparators(out);
    }
    out = CodeReplacer._normalizeRealNewlines(out);
    return out;
  }

  /**
   * Prepare the REPLACEMENT for writing.
   * Conservative: only unescape line separators if the string is itself
   * escaped (mirrors the needle's format). Inline "\n" inside JS string
   * literals is preserved because it lives in a string that also contains
   * real newlines — and `_usesEscapedNewlines` returns false for those.
   */
  static _prepareReplacement(s) {
    let out = s;
    if (CodeReplacer._usesEscapedNewlines(out)) {
      out = CodeReplacer._unescapeLineSeparators(out);
    }
    out = CodeReplacer._normalizeRealNewlines(out);
    return out;
  }

  /**
   * Produce a compact, human-readable diagnostic for why a literal
   * string did not match inside `haystack`. Returns null when the string
   * IS found (so callers can treat null === "match").
   */
  static _diagnose(haystack, needle) {
    if (haystack.includes(needle)) return null;

    const firstLine = needle.split('\n')[0];
    const searchFor = firstLine.trim().length > 0 ? firstLine.trim() : firstLine;

    let bestPos = -1;
    if (searchFor.length > 0) {
      bestPos = haystack.indexOf(searchFor);
    }

    const details = [];

    if (bestPos === -1) {
      details.push('  → No anchor line found anywhere in the file.');
      details.push(`  → First needle line was: ${JSON.stringify(firstLine)}`);
      details.push(`  → Haystack CRLF present: ${haystack.includes('\r\n')}`);
      details.push(`  → Needle  CRLF present: ${needle.includes('\r\n')}`);
      return details.join('\n');
    }

    const needleLines = needle.split('\n');
    const hayLines = haystack.slice(bestPos).split('\n');

    let firstMismatch = -1;
    for (let i = 0; i < needleLines.length; i++) {
      if (i >= hayLines.length) { firstMismatch = i; break; }
      if (needleLines[i] !== hayLines[i]) { firstMismatch = i; break; }
    }

    if (firstMismatch === -1) {
      details.push('  → Lines match from anchor but needle extends beyond file (truncated match).');
      return details.join('\n');
    }

    const nLine = needleLines[firstMismatch];
    const hLine = hayLines[firstMismatch];

    details.push(`  → First divergence at needle line ${firstMismatch + 1}:`);
    details.push(`     needle: ${JSON.stringify(nLine)}`);
    details.push(`     file:   ${JSON.stringify(hLine)}`);

    const maxCmp = Math.max(nLine.length, hLine.length);
    let col = -1;
    for (let c = 0; c < maxCmp; c++) {
      if (nLine[c] !== hLine[c]) { col = c; break; }
    }
    if (col !== -1) {
      details.push(`     first char diff at column ${col}:`);
      details.push(`       needle char: ${JSON.stringify(nLine[col] ?? '<EOL>')}`);
      details.push(`       file   char: ${JSON.stringify(hLine[col] ?? '<EOL>')}`);
    }

    if (nLine.trim() === hLine.trim()) {
      details.push('     ⚠ Lines differ only by leading/trailing whitespace.');
    }

    if (haystack.includes('\r\n') && !needle.includes('\r\n')) {
      details.push('  ⚠ File uses CRLF line endings but needle uses LF (or vice-versa).');
    }

    if (nLine.match(/^\t/) && hLine.match(/^ /)) {
      details.push('  ⚠ Needle indents with TAB, file indents with SPACES.');
    } else if (nLine.match(/^ /) && hLine.match(/^\t/)) {
      details.push('  ⚠ Needle indents with SPACES, file indents with TAB.');
    } else {
      const nIndent = (nLine.match(/^[ \t]*/) || [''])[0].length;
      const hIndent = (hLine.match(/^[ \t]*/) || [''])[0].length;
      if (nIndent !== hIndent) {
        details.push(`  ⚠ Indentation differs: needle=${nIndent} chars, file=${hIndent} chars.`);
      }
    }

    return details.join('\n');
  }

  /**
   * Normalize and correct common path errors in AI-generated paths.
   * Specifically fixes patterns like /./ to /._/ when the intent is clearly 
   * to reference a hidden directory with underscore naming.
   * 
   * @param {string} filePath - The raw file path to normalize.
   * @returns {string} The corrected file path.
   */
  static normalizePath(filePath) {
    // Only correct the specific pattern where /./ appears (not .hidden or ../)
    // The regex matches "/./" but not "/../" or "/.hidden/"
    return filePath.replace(/(?<!\.)\/(?=\.\/)/g, '/');
  }

  /**
   * Replace literal strings in a file.
   *
   * Matching rules:
   *  - File content and needle are both LF-normalized for comparison.
   *  - If the needle arrived escaped ("\r\n" as text), it is unescaped
   *    exactly once before matching. Same for the replacement, but ONLY
   *    when the replacement itself is fully escaped — so real source code
   *    containing inline "\n" inside JS string literals is never corrupted.
   *  - After replacement, the file is written back in its original
   *    line-ending style (LF stays LF, CRLF stays CRLF).
   *
   * @param {string} filePath - Absolute path to the target file.
   * @param {Object|Object[]} replacements - Single object or array of { original, replace }.
   * @returns {Promise<{content: string, changes: Array<{original: string, replace: string, count: number}>}>} 
   *          The new file content and details of all replacements made.
   */
  static async Run(filePath, replacements) {
    // Normalize input to an array
    const list = Array.isArray(replacements) ? replacements : [replacements];

    // Validate each replacement object
    for (const item of list) {
      if (typeof item !== 'object' || item === null ||
          typeof item.original !== 'string' || typeof item.replace !== 'string') {
        throw new Error('Each replacement must be an object with string properties "original" and "replace".');
      }
    }

    // Read file content
    const rawContent = await readFile(filePath, 'utf8');

    // Preserve the file's original line ending style
    const originalHadCRLF = rawContent.includes('\r\n');
    const originalHadCR   = !originalHadCRLF && rawContent.includes('\r');

    // Working copy in LF space (real newlines only; escapes untouched)
    let content = CodeReplacer._normalizeRealNewlines(rawContent);

    const changes = [];

    if (CodeReplacer.debug) {
      CodeReplacer._dbg(`Run() file=${filePath}`);
      CodeReplacer._dbg(`Run() file length=${rawContent.length} chars`);
      CodeReplacer._dbg(`Run() CRLF present: ${originalHadCRLF}`);
      CodeReplacer._dbg(`Run() replacements to attempt: ${list.length}`);
    }

    for (let i = 0; i < list.length; i++) {
      const rawOriginal = list[i].original;
      const rawReplace  = list[i].replace;

      // Prepare needle (safe: needle is only used for matching)
      const needle = CodeReplacer._prepareNeedle(rawOriginal);

      // Prepare replacement ONLY if it mirrors the needle's escaped format.
      // A fully-escaped replacement has no real newlines, so unescaping it
      // cannot corrupt inline "\n" in real source. A real source replacement
      // has real newlines, so we leave its escapes alone.
      const replacement = CodeReplacer._prepareReplacement(rawReplace);

      if (CodeReplacer.debug) {
        CodeReplacer._dbg(`---`);
        CodeReplacer._dbg(`Replacement #${i + 1}:`);
        CodeReplacer._dbg(`  raw needle  len=${rawOriginal.length}  escaped=${CodeReplacer._usesEscapedNewlines(rawOriginal)}`);
        CodeReplacer._dbg(`  raw replace len=${rawReplace.length}  escaped=${CodeReplacer._usesEscapedNewlines(rawReplace)}`);
        CodeReplacer._dbg(`  needle  first 80: ${JSON.stringify(needle.slice(0, 80))}`);
        CodeReplacer._dbg(`  needle  last  80: ${JSON.stringify(needle.slice(-80))}`);
        CodeReplacer._dbg(`  replace first 80: ${JSON.stringify(replacement.slice(0, 80))}`);
      }

      const parts = content.split(needle);
      const count = parts.length - 1;

      if (CodeReplacer.debug) {
        CodeReplacer._dbg(`  Occurrences found: ${count}`);
        if (count === 0) {
          const diag = CodeReplacer._diagnose(content, needle);
          if (diag) {
            CodeReplacer._dbg('Why it did NOT match:');
            console.error(diag);
          }
        }
      }

      if (count > 0) {
        content = parts.join(replacement);
        changes.push({
          // Report the raw strings so external logging is unchanged
          original: rawOriginal,
          replace:  rawReplace,
          count
        });
      }
    }

    // Restore the file's original line-ending style
    let finalContent = content;
    if (originalHadCRLF) {
      finalContent = content.replace(/\n/g, '\r\n');
    } else if (originalHadCR) {
      finalContent = content.replace(/\n/g, '\r');
    }

    // Write back to file only if changes were made
    if (changes.length > 0) {
      await writeFile(filePath, finalContent, 'utf8');
      if (CodeReplacer.debug) {
        CodeReplacer._dbg(`Wrote ${changes.length} replacement(s) back to ${filePath}`);
        CodeReplacer._dbg(`Line-ending style restored: ${originalHadCRLF ? 'CRLF' : originalHadCR ? 'CR' : 'LF'}`);
      }
    } else if (CodeReplacer.debug) {
      CodeReplacer._dbg(`No changes written (0 replacements applied).`);
    }

    return { content: finalContent, changes };
  }

  /**
   * Process a (possibly partial) tagged string, accumulate until complete.
   * Can process multiple blocks in a single input.
   * @param {string} input - String chunk containing part of the CODEREPLACER block(s).
   * @returns {Promise<{status: 'waiting'|'finish'|'error', blocks_processed?: number, 
   *                    changes?: Array<{file: string, replacements: Array<{original: string, replace: string, count: number}>}>, 
   *                    error?: string}>}
   */
  static async Tag(input) {
    const START = '[CODEREPLACER-START]';
    const END = '[/CODEREPLACER-END]';

    // Accumulate input
    CodeReplacer.tagBuffer += input;

    // Check if we have at least one complete block
    const startIdx = CodeReplacer.tagBuffer.indexOf(START);
    const endIdx = CodeReplacer.tagBuffer.indexOf(END, startIdx + START.length);

    if (startIdx === -1 || endIdx === -1) {
      if (CodeReplacer.debug) {
        CodeReplacer._dbg(`Tag(): waiting — START found: ${startIdx !== -1}, END found: ${endIdx !== -1}, buffer length=${CodeReplacer.tagBuffer.length}`);
      }
      return { status: 'waiting' };
    }

    const allChanges = [];
    let blocksProcessed = 0;

    try {
      while (true) {
        const currentStart = CodeReplacer.tagBuffer.indexOf(START);
        const currentEnd = CodeReplacer.tagBuffer.indexOf(END, currentStart + START.length);

        if (currentStart === -1 || currentEnd === -1) break;

        const block = CodeReplacer.tagBuffer.slice(currentStart, currentEnd + END.length);
        CodeReplacer.tagBuffer = CodeReplacer.tagBuffer.slice(currentEnd + END.length);

        const pathMatch = block.match(/PATH='([^']*)'/);
        if (!pathMatch) {
          throw new Error(`Block ${blocksProcessed + 1}: PATH not found.`);
        }
        
        const rawFilePath = pathMatch[1];
        const filePath = CodeReplacer.normalizePath(rawFilePath);

        if (CodeReplacer.debug) {
          CodeReplacer._dbg(`Block ${blocksProcessed + 1}: PATH raw=${JSON.stringify(rawFilePath)}, normalized=${JSON.stringify(filePath)}`);
        }
        
        const replacementBlocks = [];
        const replRegex = /\[NEW-REPLACE-START\]([\s\S]*?)\[\/NEW-REPLACE-END\]/g;
        let match;
        while ((match = replRegex.exec(block)) !== null) {
          const inner = match[1];
          const origMatch = inner.match(/\[ORIGINAL-START\]([\s\S]*?)\[\/ORIGINAL-END\]/);
          const replMatch = inner.match(/\[REPLACE-START\]([\s\S]*?)\[\/REPLACE-END\]/);
          if (origMatch && replMatch) {
            // Store RAW strings; unescaping is decided per-string inside Run().
            replacementBlocks.push({
              original: origMatch[1],
              replace:  replMatch[1],
            });
          } else {
            throw new Error(`Block ${blocksProcessed + 1}: Malformed replacement block - missing ORIGINAL or REPLACE section.`);
          }
        }

        if (replacementBlocks.length === 0) {
          throw new Error(`Block ${blocksProcessed + 1}: No replacement blocks found.`);
        }

        if (CodeReplacer.debug) {
          CodeReplacer._dbg(`Block ${blocksProcessed + 1}: found ${replacementBlocks.length} replacement sub-block(s).`);
        }

        const result = await CodeReplacer.Run(filePath, replacementBlocks);
        
        if (result.changes.length > 0) {
          allChanges.push({
            file: filePath,
            replacements: result.changes
          });
        }

        blocksProcessed++;
      }

      return { 
        status: 'finish', 
        blocks_processed: blocksProcessed,
        changes: allChanges 
      };
    } catch (err) {
      return { status: 'error', error: err.message };
    }
  }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import('fs/promises');

  const argv = process.argv.slice(2);
  const debugIdx = argv.findIndex(a => a === '--debug' || a === '-d');
  if (debugIdx !== -1) {
    CodeReplacer.debug = true;
    argv.splice(debugIdx, 1);
  }

  const fileToRead = argv[0] || 'result';

  if (CodeReplacer.debug) {
    console.error('[DEBUG] Debug mode enabled.');
    console.error(`[DEBUG] Reading input file: ${fileToRead}`);
  }
  
  try {
    const content = await fs.readFile(fileToRead, 'utf8');
    const result = await CodeReplacer.Tag(content);
    
    if (result.status === 'finish') {
      console.log('✓ Replacements applied successfully!\n');
      
      if (result.blocks_processed === 0) {
        console.log('No blocks were processed.');
      } else {
        console.log(`Blocks processed: ${result.blocks_processed}`);
        
        if (result.changes.length === 0) {
          console.log('No changes were necessary (all originals already absent).');
          if (CodeReplacer.debug) {
            console.error('[DEBUG] All ORIGINAL strings were reported as not-found (count=0). See divergence diagnostics above.');
          }
        } else {
          console.log('Changes made:\n');
          
          result.changes.forEach((change, idx) => {
            console.log(`${'─'.repeat(50)}`);
            console.log(`File: ${change.file}`);
            console.log(`${'─'.repeat(50)}`);
            
            change.replacements.forEach((repl, replIdx) => {
              console.log(`\n  Replacement ${replIdx + 1}:`);
              console.log(`    Occurrences: ${repl.count}`);
              
              const origPreview = repl.original.length > 40 
                ? repl.original.substring(0, 37) + '...' 
                : repl.original;
              const replPreview = repl.replace.length > 40 
                ? repl.replace.substring(0, 37) + '...' 
                : repl.replace;
              
              console.log(`    Original: "${origPreview}"`);
              console.log(`    Replace:  "${replPreview}"`);
            });
            
            if (idx < result.changes.length - 1) {
              console.log('');
            }
          });
          
          const totalReplacements = result.changes.reduce((sum, change) => 
            sum + change.replacements.reduce((s, repl) => s + repl.count, 0), 0
          );
          
          console.log(`\n${'='.repeat(50)}`);
          console.log(`Total replacements made: ${totalReplacements}`);
        }
      }
    } else if (result.status === 'waiting') {
      console.log('⚠ Input was incomplete. Expected full [CODEREPLACER-START]...[/CODEREPLACER-END] block(s).');
    } else {
      console.error('✗ Error:', result.error);
    }
  } catch (err) {
    console.error('✗ Failed to read file:', err.message);
  }
}
