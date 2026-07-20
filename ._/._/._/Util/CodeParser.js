// code-parser-interface.js
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class CodeParser {
    static #sourceCode = '';
    static #filePath = '';
    static #originalParts = null;
    
    static analyzeCode(code) {
        this.#sourceCode = code;
        const analysis = {
            imports: this.extractImports(code),
            exports: this.extractExports(code),
            classes: this.extractClasses(code),
            functions: this.extractFunctions(code),
            variables: this.extractVariables(code),
            comments: this.extractComments(code),
            blocks: this.extractCodeBlocks(code),
            allParts: () => this.getAllParts(code)
        };
        
        this.#originalParts = {
            imports: [...analysis.imports],
            exports: [...analysis.exports],
            classes: [...analysis.classes],
            functions: [...analysis.functions],
            variables: [...analysis.variables],
            comments: [...analysis.comments]
        };
        
        return analysis;
    }

    static extractImports(code) {
        const imports = [];
        const regex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s*,?\s*)*\s*from\s+['"][^'"]+['"]\s*;?/g;
        let match;
        while ((match = regex.exec(code)) !== null) {
            imports.push({
                type: 'import',
                name: match[0].trim(),
                start: match.index,
                end: match.index + match[0].length,
                content: match[0]
            });
        }
        return imports;
    }

    static extractExports(code) {
        const exports = [];
        const patterns = [
            /export\s+default\s+(?:class|function|const|let|var)?\s*(\w+)?/g,
            /export\s+(?:const|let|var|function|class)\s+(\w+)/g,
            /export\s+\{[^}]+\}/g,
            /module\.exports\s*=\s*[^;]+;?/g
        ];
        
        patterns.forEach(regex => {
            let match;
            const newRegex = new RegExp(regex.source, regex.flags);
            while ((match = newRegex.exec(code)) !== null) {
                exports.push({
                    type: 'export',
                    name: match[1] || match[0].trim(),
                    start: match.index,
                    end: match.index + match[0].length,
                    content: match[0]
                });
            }
        });
        return exports;
    }

    static extractClasses(code) {
        const classes = [];
        const regex = /class\s+(\w+)(?:\s+extends\s+(\w+))?\s*\{/g;
        let match;
        while ((match = regex.exec(code)) !== null) {
            const className = match[1];
            const extendsClass = match[2] || null;
            const start = match.index;
            const end = this.findMatchingBrace(code, match.index + match[0].length - 1) + 1;
            
            const classContent = code.substring(start, end);
            classes.push({
                type: 'class',
                name: className,
                extends: extendsClass,
                start,
                end,
                content: classContent,
                methods: this.extractClassMethods(classContent)
            });
        }
        return classes;
    }

    static extractFunctions(code) {
        const functions = [];
        
        const classRanges = this.extractClasses(code).map(cls => ({
            start: cls.start,
            end: cls.end
        }));
        
        const isInsideAnyClass = (pos) => {
            return classRanges.some(range => pos > range.start && pos < range.end);
        };
        
        const funcDeclRegex = /(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*\{/g;
        let match;
        while ((match = funcDeclRegex.exec(code)) !== null) {
            if (!isInsideAnyClass(match.index)) {
                const funcName = match[1];
                const start = match.index;
                const end = this.findMatchingBrace(code, match.index + match[0].length - 1) + 1;
                
                functions.push({
                    type: 'function',
                    name: funcName,
                    start,
                    end,
                    content: code.substring(start, end),
                    isAsync: match[0].includes('async')
                });
            }
        }
        
        const arrowFuncRegex = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g;
        while ((match = arrowFuncRegex.exec(code)) !== null) {
            if (!isInsideAnyClass(match.index)) {
                const funcName = match[1];
                const start = match.index;
                const end = this.findMatchingBrace(code, match.index + match[0].length - 1) + 1;
                
                functions.push({
                    type: 'function',
                    name: funcName,
                    start,
                    end,
                    content: code.substring(start, end),
                    isAsync: match[0].includes('async'),
                    isArrow: true
                });
            }
        }
        
        const methodAssignRegex = /(\w+)\s*:\s*(?:async\s*)?(?:function\s*)?\([^)]*\)\s*(?:=>\s*)?\{/g;
        while ((match = methodAssignRegex.exec(code)) !== null) {
            if (!isInsideAnyClass(match.index)) {
                const funcName = match[1];
                const start = match.index;
                const end = this.findMatchingBrace(code, match.index + match[0].length - 1) + 1;
                
                functions.push({
                    type: 'function',
                    name: funcName,
                    start,
                    end,
                    content: code.substring(start, end),
                    isAsync: match[0].includes('async'),
                    isMethod: true
                });
            }
        }
        
        return functions;
    }

    static extractVariables(code) {
        const variables = [];
        const classRanges = this.extractClasses(code).map(cls => ({
            start: cls.start,
            end: cls.end
        }));
        
        const functionRanges = this.extractFunctions(code).map(func => ({
            start: func.start,
            end: func.end
        }));
        
        const isInsideStructure = (pos) => {
            return classRanges.some(range => pos > range.start && pos < range.end) ||
                   functionRanges.some(range => pos > range.start && pos < range.end);
        };
        
        const regex = /(?:const|let|var)\s+(\w+)\s*=\s*[^;]+;?/g;
        let match;
        while ((match = regex.exec(code)) !== null) {
            if (!isInsideStructure(match.index) && !match[0].includes('=>') && !match[0].includes('function')) {
                variables.push({
                    type: 'variable',
                    name: match[1],
                    start: match.index,
                    end: match.index + match[0].length,
                    content: match[0].trim()
                });
            }
        }
        return variables;
    }

    static extractComments(code) {
        const comments = [];
        const patterns = [
            { regex: /\/\/.*$/gm, type: 'single-line' },
            { regex: /\/\*[\s\S]*?\*\//g, type: 'multi-line' }
        ];
        
        patterns.forEach(({ regex, type }) => {
            let match;
            while ((match = regex.exec(code)) !== null) {
                comments.push({
                    type: 'comment',
                    commentType: type,
                    start: match.index,
                    end: match.index + match[0].length,
                    content: match[0]
                });
            }
        });
        return comments;
    }

    static extractCodeBlocks(code) {
        const blocks = [];
        const regex = /\{[\s\S]*?\}/g;
        let match;
        while ((match = regex.exec(code)) !== null) {
            blocks.push({
                type: 'block',
                start: match.index,
                end: match.index + match[0].length,
                content: match[0]
            });
        }
        return blocks;
    }

    static getAllParts(code) {
        return [
            ...this.extractImports(code),
            ...this.extractExports(code),
            ...this.extractClasses(code),
            ...this.extractFunctions(code),
            ...this.extractVariables(code)
        ].sort((a, b) => a.start - b.start);
    }

    static findMatchingBrace(code, startIndex) {
        let depth = 1;
        let index = startIndex + 1;
        let inString = false;
        let stringChar = '';
        
        while (depth > 0 && index < code.length) {
            const char = code[index];
            
            if ((char === '"' || char === "'" || char === '`') && code[index - 1] !== '\\') {
                if (!inString) {
                    inString = true;
                    stringChar = char;
                } else if (char === stringChar) {
                    inString = false;
                }
            }
            
            if (char === '`' && code[index - 1] !== '\\') {
                if (!inString) {
                    inString = true;
                    stringChar = '`';
                } else if (stringChar === '`') {
                    inString = false;
                }
            }
            
            if (!inString) {
                if (char === '{') depth++;
                if (char === '}') depth--;
            }
            
            if (depth === 0) return index;
            index++;
        }
        return code.length - 1;
    }

    static extractClassMethods(classCode) {
        const methods = [];
        const regex = /(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/g;
        let match;
        while ((match = regex.exec(classCode)) !== null) {
            if (match[1] !== 'constructor') {
                const start = match.index;
                const end = this.findMatchingBrace(classCode, match.index + match[0].length - 1) + 1;
                methods.push({ 
                    name: match[1],
                    start,
                    end,
                    content: classCode.substring(start, end)
                });
            }
        }
        return methods;
    }

    static findAnchorPoints(code, removedParts) {
        const anchors = [];
        
        removedParts.forEach((part, index) => {
            const beforeStart = Math.max(0, part.start - 200);
            const beforeEnd = part.start;
            const afterStart = part.end;
            const afterEnd = Math.min(code.length, part.end + 200);
            
            const contextBefore = code.substring(beforeStart, beforeEnd).trim();
            const contextAfter = code.substring(afterStart, afterEnd).trim();
            
            const beforeLines = contextBefore.split('\n');
            const afterLines = contextAfter.split('\n');
            
            const anchorBefore = beforeLines[beforeLines.length - 1]?.trim() || '';
            const anchorAfter = afterLines[0]?.trim() || '';
            
            anchors.push({
                part: part,
                index: index,
                anchorBefore: anchorBefore,
                anchorAfter: anchorAfter,
                originalStart: part.start,
                originalEnd: part.end,
                content: part.content
            });
        });
        
        return anchors;
    }

    static createMergeScript(removedParts, originalCode, filteredOptions) {
        const anchors = this.findAnchorPoints(originalCode, removedParts);
        const anchorsData = anchors.map(a => ({
            name: a.part.name,
            type: a.part.type,
            content: a.content,
            anchorBefore: a.anchorBefore,
            anchorAfter: a.anchorAfter,
            originalStart: a.originalStart,
            originalEnd: a.originalEnd
        }));
        
        const mergeScript = `#!/usr/bin/env node
/**
 * Auto-generated Merge Script
 * Generated by Code Parser on ${new Date().toISOString()}
 * This script reinserts previously removed parts back into the filtered file.
 * 
 * Usage: node merge-script.js <path-to-updated-filtered-file.js>
 * 
 * The script handles:
 * - Reinserting removed parts in their original positions
 * - Adapting to new code that may have been added to the filtered version
 * - Preserving any updates made to the filtered version
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Data about removed parts
const removedPartsData = ${JSON.stringify(anchorsData, null, 2)};

// Filter options that were used
const filteredOptions = ${JSON.stringify(filteredOptions, null, 2)};

/**
 * Calculate string similarity using Levenshtein distance
 */
function calculateSimilarity(str1, str2) {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.length === 0) return 1.0;
    
    const costs = new Array();
    for (let i = 0; i <= shorter.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= longer.length; j++) {
            if (i === 0) {
                costs[j] = j;
            } else if (j > 0) {
                let newValue = costs[j - 1];
                if (shorter.charAt(i - 1) !== longer.charAt(j - 1)) {
                    newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                }
                costs[j - 1] = lastValue;
                lastValue = newValue;
            }
        }
        if (i > 0) costs[longer.length] = lastValue;
    }
    
    return (longer.length - costs[longer.length]) / longer.length;
}

/**
 * Determine the appropriate separator between code sections
 */
function determineSeparator(before, after, part) {
    const beforeEndsWithNewline = before.endsWith('\\n') || before.endsWith('\\n\\n');
    const afterStartsWithNewline = after.startsWith('\\n');
    
    if (!beforeEndsWithNewline && !afterStartsWithNewline) {
        return '\\n\\n';
    } else if (!beforeEndsWithNewline) {
        return '\\n';
    } else {
        return '';
    }
}

/**
 * Find the best insertion point for a removed part
 */
function findInsertionPoint(code, part) {
    const strategies = [
        // Strategy 1: Exact anchor match (HIGH confidence)
        () => {
            const beforeIndex = code.indexOf(part.anchorBefore);
            const afterIndex = code.indexOf(part.anchorAfter);
            
            if (beforeIndex !== -1 && afterIndex !== -1) {
                const betweenStart = beforeIndex + part.anchorBefore.length;
                if (betweenStart <= afterIndex) {
                    return {
                        found: true,
                        position: betweenStart,
                        confidence: 'HIGH'
                    };
                }
            }
            return null;
        },
        
        // Strategy 2: Partial anchor match - before only (MEDIUM confidence)
        () => {
            const beforeIndex = code.indexOf(part.anchorBefore);
            if (beforeIndex !== -1) {
                return {
                    found: true,
                    position: beforeIndex + part.anchorBefore.length,
                    confidence: 'MEDIUM'
                };
            }
            return null;
        },
        
        // Strategy 3: Partial anchor match - after only (MEDIUM confidence)
        () => {
            const afterIndex = code.indexOf(part.anchorAfter);
            if (afterIndex !== -1) {
                return {
                    found: true,
                    position: afterIndex,
                    confidence: 'MEDIUM'
                };
            }
            return null;
        },
        
        // Strategy 4: Fuzzy matching (LOW confidence)
        () => {
            const lines = code.split('\\n');
            const anchorLines = part.anchorBefore.split('\\n');
            
            for (let i = 0; i < lines.length; i++) {
                const similarity = calculateSimilarity(
                    lines.slice(i, i + anchorLines.length).join('\\n'),
                    part.anchorBefore
                );
                
                if (similarity > 0.7) {
                    const position = lines.slice(0, i + anchorLines.length).join('\\n').length + 1;
                    return {
                        found: true,
                        position: position,
                        confidence: 'LOW'
                    };
                }
            }
            return null;
        },
        
        // Strategy 5: Type-based insertion (LOW confidence)
        () => {
            const typePatterns = {
                'class': /class\\s+\\w+/g,
                'function': /(?:async\\s+)?function\\s+\\w+/g,
                'variable': /(?:const|let|var)\\s+\\w+\\s*=/g,
                'import': /import\\s+.*from/g,
                'export': /export\\s+/g
            };
            
            const pattern = typePatterns[part.type];
            if (pattern) {
                const matches = [...code.matchAll(pattern)];
                if (matches.length > 0) {
                    const lastMatch = matches[matches.length - 1];
                    let endPos = lastMatch.index + lastMatch[0].length;
                    
                    if (part.type === 'import') {
                        const semicolon = code.indexOf(';', endPos);
                        if (semicolon !== -1) endPos = semicolon + 1;
                    }
                    
                    return {
                        found: true,
                        position: endPos,
                        confidence: 'LOW'
                    };
                }
            }
            return null;
        },
        
        // Strategy 6: Append to end (FALLBACK confidence)
        () => {
            return {
                found: true,
                position: code.length,
                confidence: 'FALLBACK'
            };
        }
    ];
    
    for (const strategy of strategies) {
        const result = strategy();
        if (result) return result;
    }
    
    return { found: false };
}

/**
 * Merge removed parts back into the filtered code
 */
function merge(filteredCode) {
    console.log('🔄 Starting merge process...');
    console.log(\`📊 Removed parts to reinsert: \${removedPartsData.length}\`);
    
    let mergedCode = filteredCode;
    let reinsertedCount = 0;
    const warnings = [];
    
    // Sort parts by original position (reverse order to maintain positions)
    const sortedParts = [...removedPartsData].sort((a, b) => b.originalStart - a.originalStart);
    
    for (const part of sortedParts) {
        const insertionPoint = findInsertionPoint(mergedCode, part);
        
        if (insertionPoint.found) {
            const before = mergedCode.substring(0, insertionPoint.position);
            const after = mergedCode.substring(insertionPoint.position);
            const separator = determineSeparator(before, after, part);
            
            mergedCode = before + separator + part.content + '\\n' + after;
            reinsertedCount++;
            
            console.log(\`✅ Reinserted: \${part.type} "\${part.name}" at position \${insertionPoint.position}\`);
            console.log(\`   Confidence: \${insertionPoint.confidence}\`);
        } else {
            const warning = \`⚠️  Could not find insertion point for \${part.type} "\${part.name}". It may need manual reinsertion.\`;
            warnings.push(warning);
            console.log(warning);
            console.log(\`   Content to reinsert manually:\`);
            console.log(\`   \${part.content.substring(0, 100)}...\`);
        }
    }
    
    return {
        code: mergedCode,
        reinsertedCount,
        warnings,
        success: warnings.length === 0
    };
}

// Main execution
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log('📦 Merge Script for Filtered Code');
        console.log('═'.repeat(50));
        console.log('Usage: node merge-script.js <path-to-updated-filtered-file.js>');
        console.log('');
        console.log('This script will:');
        console.log('• Read the updated filtered file');
        console.log('• Find original positions for removed parts');
        console.log('• Reinsert the removed parts intelligently');
        console.log('• Handle cases where new code was added');
        console.log('• Save the merged result');
        console.log('');
        console.log('Options:');
        console.log('  --output <file>     Specify output file (default: input_merged.js)');
        console.log('  --dry-run          Show what would be done without writing file');
        console.log('  --manual           Generate manual insertion guide');
        process.exit(0);
    }
    
    const targetFile = args[0];
    const outputFile = args.includes('--output') 
        ? args[args.indexOf('--output') + 1]
        : targetFile.replace('.js', '_merged.js');
    const dryRun = args.includes('--dry-run');
    const generateManual = args.includes('--manual');
    
    if (!fs.existsSync(targetFile)) {
        console.error(\`❌ File not found: \${targetFile}\`);
        process.exit(1);
    }
    
    console.log('🔧 Merge Script');
    console.log('═'.repeat(50));
    console.log(\`📄 Target file: \${targetFile}\`);
    console.log(\`📊 Removed parts to merge: \${removedPartsData.length}\`);
    
    const filteredCode = fs.readFileSync(targetFile, 'utf-8');
    const result = merge(filteredCode);
    
    if (dryRun) {
        console.log('\\n📋 Dry Run Results:');
        console.log(\`   Parts reinserted: \${result.reinsertedCount}/\${removedPartsData.length}\`);
        if (result.warnings.length > 0) {
            console.log(\`   Warnings: \${result.warnings.length}\`);
            result.warnings.forEach(w => console.log(\`   \${w}\`));
        }
        console.log('   No files were modified (--dry-run)');
    } else {
        fs.writeFileSync(outputFile, result.code);
        console.log(\`\\n✅ Merged file saved to: \${outputFile}\`);
        console.log(\`📊 Parts reinserted: \${result.reinsertedCount}/\${removedPartsData.length}\`);
        console.log(\`📏 Original filtered size: \${filteredCode.length} chars\`);
        console.log(\`📏 Merged size: \${result.code.length} chars\`);
        
        if (result.warnings.length > 0) {
            console.log(\`\\n⚠️  Warnings (\${result.warnings.length}):\`);
            result.warnings.forEach(w => console.log(w));
        }
    }
    
    if (generateManual) {
        console.log('\\n📖 Manual Insertion Guide:');
        console.log('═'.repeat(50));
        removedPartsData.forEach((part, index) => {
            console.log(\`\\n\${index + 1}. \${part.type.toUpperCase()}: \${part.name}\`);
            console.log('   Content:');
            console.log(\`   \${part.content.split('\\n').map(l => '   ' + l).join('\\n')}\`);
            console.log(\`   Anchor before: "\${part.anchorBefore.substring(0, 50)}..."\`);
            console.log(\`   Anchor after: "\${part.anchorAfter.substring(0, 50)}..."\`);
        });
    }
}

main().catch(console.error);
`;
        
        return mergeScript;
    }

    static createFilteredCode(analysis, options = {}) {
        const {
            includeImports = true,
            includeExports = true,
            includeClasses = [],
            excludeClasses = [],
            includeFunctions = [],
            excludeFunctions = [],
            includeVariables = [],
            excludeVariables = [],
            mode = 'exclude',
            generateMergeScript = false,
            mergeScriptPath = null
        } = options;

        const originalCode = this.#sourceCode;
        let partsToRemove = [];
        
        if (!includeImports) {
            partsToRemove.push(...analysis.imports);
        }
        
        if (!includeExports) {
            partsToRemove.push(...analysis.exports);
        }

        if (mode === 'include') {
            if (includeClasses.length > 0) {
                partsToRemove.push(...analysis.classes.filter(c => !includeClasses.includes(c.name)));
            }
        } else {
            partsToRemove.push(...analysis.classes.filter(c => excludeClasses.includes(c.name)));
        }

        if (mode === 'include') {
            if (includeFunctions.length > 0) {
                partsToRemove.push(...analysis.functions.filter(f => !includeFunctions.includes(f.name)));
            }
        } else {
            partsToRemove.push(...analysis.functions.filter(f => excludeFunctions.includes(f.name)));
        }

        if (mode === 'include') {
            if (includeVariables.length > 0) {
                partsToRemove.push(...analysis.variables.filter(v => !includeVariables.includes(v.name)));
            }
        } else {
            partsToRemove.push(...analysis.variables.filter(v => excludeVariables.includes(v.name)));
        }

        partsToRemove.sort((a, b) => b.start - a.start);
        
        let filteredCode = originalCode;
        
        for (const part of partsToRemove) {
            const before = filteredCode.substring(0, part.start);
            const after = filteredCode.substring(part.end);
            
            let cleanedBefore = before;
            let cleanedAfter = after;
            
            cleanedBefore = cleanedBefore.replace(/\s+$/, '');
            cleanedAfter = cleanedAfter.replace(/^\s+/, '');
            
            if (cleanedBefore.length > 0 && cleanedAfter.length > 0) {
                const beforeLastChar = cleanedBefore[cleanedBefore.length - 1];
                const afterFirstChar = cleanedAfter[0];
                
                if ((beforeLastChar === '}' || beforeLastChar === ';') && 
                    (afterFirstChar.match(/[a-zA-Z]/) || afterFirstChar === 'e' || afterFirstChar === 'i' || afterFirstChar === 'c')) {
                    filteredCode = cleanedBefore + '\n\n' + cleanedAfter;
                } else if (beforeLastChar === '\n') {
                    filteredCode = cleanedBefore + cleanedAfter;
                } else {
                    filteredCode = cleanedBefore + '\n' + cleanedAfter;
                }
            } else {
                filteredCode = cleanedBefore + cleanedAfter;
            }
        }
        
        let mergeScriptGenerated = false;
        let actualMergeScriptPath = null;
        
        if (generateMergeScript && partsToRemove.length > 0) {
            const mergeScript = this.createMergeScript(partsToRemove, originalCode, options);
            actualMergeScriptPath = mergeScriptPath || this.#filePath.replace('.js', '_merge.js');
            fs.writeFileSync(actualMergeScriptPath, mergeScript);
            mergeScriptGenerated = true;
        }
        
        return {
            code: filteredCode,
            removedParts: partsToRemove,
            mergeScriptGenerated,
            mergeScriptPath: actualMergeScriptPath
        };
    }

    static async runInteractive() {
        const args = process.argv.slice(2);
        if (args.length === 0) {
            console.log('Usage: node code-parser-interface.js <filename.js>');
            console.log('Example: node code-parser-interface.js sample-test.js');
            process.exit(1);
        }

        this.#filePath = args[0];
        
        if (!fs.existsSync(this.#filePath)) {
            console.error(`❌ File not found: ${this.#filePath}`);
            process.exit(1);
        }

        const code = fs.readFileSync(this.#filePath, 'utf-8');
        const analysis = this.analyzeCode(code);
        
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: true
        });

        console.clear();
        console.log('🔧 JavaScript Code Parser Interface');
        console.log('═'.repeat(50));
        console.log(`📄 File: ${path.basename(this.#filePath)}`);
        console.log(`📊 Size: ${code.length} chars, ${code.split('\n').length} lines\n`);

        const menuOptions = {
            '1': { text: '📋 Show all parts', action: () => this.displayParts(analysis) },
            '2': { text: '📦 Show classes', action: () => this.displayClasses(analysis) },
            '3': { text: '🔧 Show functions', action: () => this.displayFunctions(analysis) },
            '4': { text: '📝 Show variables', action: () => this.displayVariables(analysis) },
            '5': { text: '✂️  Create filtered version (exclude) with merge script', action: () => this.filterMenuExclude(analysis, rl) },
            '6': { text: '✅ Create filtered version (include only) with merge script', action: () => this.filterMenuInclude(analysis, rl) },
            '7': { text: '💾 Export specific parts', action: () => this.exportMenu(analysis, rl) },
            '8': { text: '📊 Show statistics', action: () => this.displayStats(analysis) },
            '0': { text: '🚪 Exit', action: () => { 
                console.log('\n👋 Goodbye!');
                rl.close(); 
                process.exit(0); 
            }}
        };

        const showMenu = async () => {
            console.log('\n📌 Menu Options:');
            console.log('─'.repeat(50));
            Object.entries(menuOptions).forEach(([key, option]) => {
                console.log(`  ${key}. ${option.text}`);
            });
            
            const choice = await this.question(rl, '\n👉 Select option: ');
            
            if (menuOptions[choice]) {
                console.clear();
                await menuOptions[choice].action();
                await this.question(rl, '\nPress Enter to continue...');
                console.clear();
                showMenu();
            } else {
                console.log('❌ Invalid option. Please try again.');
                await this.question(rl, '\nPress Enter to continue...');
                console.clear();
                showMenu();
            }
        };

        showMenu();
    }

    static question(rl, prompt) {
        return new Promise((resolve) => {
            rl.question(prompt, resolve);
        });
    }

    static displayParts(analysis, page = 1, pageSize = 15) {
        const allParts = analysis.allParts();
        const totalPages = Math.ceil(allParts.length / pageSize);
        const start = (page - 1) * pageSize;
        const end = Math.min(start + pageSize, allParts.length);
        const pageItems = allParts.slice(start, end);

        console.log(`📋 All Code Parts (${allParts.length} total, showing ${start + 1}-${end}):`);
        console.log('═'.repeat(50));
        
        pageItems.forEach((part, index) => {
            const num = start + index + 1;
            console.log(`\n${num}. [${part.type.toUpperCase()}] ${part.name || 'unnamed'}`);
            if (part.isAsync) console.log('   ⚡ Async');
            if (part.extends) console.log(`   📦 Extends: ${part.extends}`);
            console.log(`   📏 Size: ${part.content.length} chars`);
            const firstLine = part.content.split('\n')[0].trim();
            console.log(`   👁️  ${firstLine.substring(0, 60)}${firstLine.length > 60 ? '...' : ''}`);
        });
    }

    static displayClasses(analysis) {
        console.log('📦 Classes:');
        console.log('═'.repeat(50));
        if (analysis.classes.length === 0) {
            console.log('   No classes found');
            return;
        }
        analysis.classes.forEach((cls, index) => {
            console.log(`\n${index + 1}. ${cls.name}${cls.extends ? ` extends ${cls.extends}` : ''}`);
            console.log(`   Methods (${cls.methods.length}): ${cls.methods.map(m => m.name).join(', ') || 'none'}`);
            console.log(`   Size: ${cls.content.length} chars`);
        });
    }

    static displayFunctions(analysis) {
        console.log('🔧 Functions:');
        console.log('═'.repeat(50));
        if (analysis.functions.length === 0) {
            console.log('   No standalone functions found');
            console.log('   (Note: Class methods are shown in "Show classes" option)');
            return;
        }
        analysis.functions.forEach((func, index) => {
            console.log(`\n${index + 1}. ${func.name}`);
            if (func.isAsync) console.log('   ⚡ Async');
            if (func.isArrow) console.log('   ➡️  Arrow function');
            if (func.isMethod) console.log('   🔗 Object method');
            console.log(`   Size: ${func.content.length} chars`);
            const firstLine = func.content.split('\n')[0].trim();
            console.log(`   👁️  ${firstLine.substring(0, 60)}${firstLine.length > 60 ? '...' : ''}`);
        });
    }

    static displayVariables(analysis) {
        console.log('📝 Variables:');
        console.log('═'.repeat(50));
        if (analysis.variables.length === 0) {
            console.log('   No top-level variables found');
            return;
        }
        analysis.variables.forEach((variable, index) => {
            console.log(`\n${index + 1}. ${variable.name}`);
            console.log(`   📏 Size: ${variable.content.length} chars`);
            console.log(`   👁️  ${variable.content.substring(0, 60)}${variable.content.length > 60 ? '...' : ''}`);
        });
    }

    static async filterMenuExclude(analysis, rl) {
        console.log('✂️  Create Filtered Version (Exclude Mode) with Merge Script');
        console.log('═'.repeat(50));
        console.log('This will remove the selected parts from the code and generate a merge script.\n');
        
        console.log('📦 Available classes:');
        if (analysis.classes.length === 0) {
            console.log('   None');
        } else {
            analysis.classes.forEach(c => console.log(`   • ${c.name}`));
        }
        
        console.log('\n🔧 Available functions:');
        if (analysis.functions.length === 0) {
            console.log('   None');
        } else {
            analysis.functions.forEach(f => console.log(`   • ${f.name}`));
        }
        
        console.log('\n📝 Available variables:');
        if (analysis.variables.length === 0) {
            console.log('   None');
        } else {
            analysis.variables.forEach(v => console.log(`   • ${v.name}`));
        }
        
        console.log('\nEnter names separated by commas, or press Enter to keep all');
        
        const excludeClasses = await this.question(rl, '\nExclude classes: ');
        const excludeFunctions = await this.question(rl, 'Exclude functions: ');
        const excludeVariables = await this.question(rl, 'Exclude variables: ');
        
        const generateMerge = await this.question(rl, '\nGenerate merge script? (y/n, default: y): ');
        const shouldGenerateMerge = generateMerge.toLowerCase() !== 'n';
        
        const options = {
            excludeClasses: excludeClasses ? excludeClasses.split(',').map(s => s.trim()).filter(Boolean) : [],
            excludeFunctions: excludeFunctions ? excludeFunctions.split(',').map(s => s.trim()).filter(Boolean) : [],
            excludeVariables: excludeVariables ? excludeVariables.split(',').map(s => s.trim()).filter(Boolean) : [],
            mode: 'exclude',
            generateMergeScript: shouldGenerateMerge
        };
        
        const result = this.createFilteredCode(analysis, options);
        const outputFile = this.#filePath.replace('.js', '_filtered.js');
        fs.writeFileSync(outputFile, result.code);
        
        console.log('\n' + '═'.repeat(50));
        console.log(`✅ Filtered code saved to: ${outputFile}`);
        console.log(`📊 Original: ${this.#sourceCode.length} chars, ${this.#sourceCode.split('\n').length} lines`);
        console.log(`📊 Filtered: ${result.code.length} chars, ${result.code.split('\n').length} lines`);
        console.log(`📊 Removed parts: ${result.removedParts.length}`);
        
        if (result.mergeScriptGenerated) {
            console.log(`\n🔧 Merge script generated: ${result.mergeScriptPath}`);
            console.log('   Run it later with: node ' + path.basename(result.mergeScriptPath) + ' <updated-filtered-file.js>');
            console.log('   This will reinsert the removed parts into the updated file.');
        }
    }

    static async filterMenuInclude(analysis, rl) {
        console.log('✅ Create Filtered Version (Include Only Mode) with Merge Script');
        console.log('═'.repeat(50));
        console.log('This will keep ONLY the selected parts from the code and generate a merge script.\n');
        
        console.log('📦 Available classes:');
        if (analysis.classes.length === 0) {
            console.log('   None');
        } else {
            analysis.classes.forEach(c => console.log(`   • ${c.name}`));
        }
        
        console.log('\n🔧 Available functions:');
        if (analysis.functions.length === 0) {
            console.log('   None');
        } else {
            analysis.functions.forEach(f => console.log(`   • ${f.name}`));
        }
        
        console.log('\n📝 Available variables:');
        if (analysis.variables.length === 0) {
            console.log('   None');
        } else {
            analysis.variables.forEach(v => console.log(`   • ${v.name}`));
        }
        
        console.log('\nEnter names separated by commas (leave empty to include none of that type)');
        
        const includeClasses = await this.question(rl, '\nInclude classes: ');
        const includeFunctions = await this.question(rl, 'Include functions: ');
        const includeVariables = await this.question(rl, 'Include variables: ');
        
        const generateMerge = await this.question(rl, '\nGenerate merge script to restore removed parts? (y/n, default: y): ');
        const shouldGenerateMerge = generateMerge.toLowerCase() !== 'n';
        
        const options = {
            includeClasses: includeClasses ? includeClasses.split(',').map(s => s.trim()).filter(Boolean) : [],
            includeFunctions: includeFunctions ? includeFunctions.split(',').map(s => s.trim()).filter(Boolean) : [],
            includeVariables: includeVariables ? includeVariables.split(',').map(s => s.trim()).filter(Boolean) : [],
            mode: 'include',
            generateMergeScript: shouldGenerateMerge
        };
        
        const result = this.createFilteredCode(analysis, options);
        const outputFile = this.#filePath.replace('.js', '_included.js');
        fs.writeFileSync(outputFile, result.code);
        
        console.log('\n' + '═'.repeat(50));
        console.log(`✅ Included code saved to: ${outputFile}`);
        console.log(`📊 Original: ${this.#sourceCode.length} chars, ${this.#sourceCode.split('\n').length} lines`);
        console.log(`📊 Included: ${result.code.length} chars, ${result.code.split('\n').length} lines`);
        console.log(`📊 Removed parts: ${result.removedParts.length}`);
        
        if (result.mergeScriptGenerated) {
            console.log(`\n🔧 Merge script generated: ${result.mergeScriptPath}`);
            console.log('   Run it later with: node ' + path.basename(result.mergeScriptPath) + ' <updated-included-file.js>');
            console.log('   This will reinsert the removed parts back into the updated file.');
        }
    }

    static async exportMenu(analysis, rl) {
        console.log('💾 Export Specific Parts');
        console.log('═'.repeat(50));
        
        const allParts = analysis.allParts();
        console.log('Available parts:');
        allParts.forEach((part, index) => {
            console.log(`  ${index + 1}. [${part.type.toUpperCase()}] ${part.name || 'unnamed'}`);
        });
        
        const numbers = await this.question(rl, '\nEnter part numbers to export (comma-separated): ');
        const indices = numbers.split(',').map(n => parseInt(n.trim()) - 1).filter(n => !isNaN(n));
        const selectedParts = indices.map(i => allParts[i]).filter(Boolean);
        
        if (selectedParts.length > 0) {
            const exportContent = selectedParts.map(p => p.content).join('\n\n');
            const outputFile = this.#filePath.replace('.js', '_exported.js');
            fs.writeFileSync(outputFile, exportContent);
            
            console.log(`\n✅ Exported ${selectedParts.length} parts to: ${outputFile}`);
            console.log(`📊 Size: ${exportContent.length} chars`);
        } else {
            console.log('❌ No valid parts selected');
        }
    }

    static displayStats(analysis) {
        console.log('📊 Code Statistics');
        console.log('═'.repeat(50));
        console.log(`📦 Classes: ${analysis.classes.length}`);
        console.log(`🔧 Functions: ${analysis.functions.length}`);
        console.log(`📝 Variables: ${analysis.variables.length}`);
        console.log(`📥 Imports: ${analysis.imports.length}`);
        console.log(`📤 Exports: ${analysis.exports.length}`);
        console.log(`💬 Comments: ${analysis.comments.length}`);
        console.log('─'.repeat(50));
        console.log(`📏 Total size: ${this.#sourceCode.length} chars`);
        console.log(`📄 Total lines: ${this.#sourceCode.split('\n').length}`);
        
        if (analysis.classes.length > 0) {
            console.log('\n📦 Classes detail:');
            analysis.classes.forEach(cls => {
                console.log(`  • ${cls.name}: ${cls.methods.length} methods`);
            });
        }
        
        if (analysis.functions.length > 0) {
            console.log('\n🔧 Functions detail:');
            analysis.functions.forEach(func => {
                const types = [];
                if (func.isAsync) types.push('async');
                if (func.isArrow) types.push('arrow');
                if (func.isMethod) types.push('method');
                const typeStr = types.length > 0 ? ` (${types.join(', ')})` : '';
                console.log(`  • ${func.name}${typeStr}`);
            });
        }
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    CodeParser.runInteractive().catch(console.error);
}

export default CodeParser;