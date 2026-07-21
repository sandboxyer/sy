// code-parser-interface.js

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// BRACE MATCHING UTILITY
// ============================================================================
class BraceMatcher {

    static findMatchingBrace(sourceCode, startIndex) {
        let depth = 1;
        let index = startIndex + 1;
        let insideString = false;
        let stringDelimiter = '';
        let insideTemplate = false;
        let insideSingleLineComment = false;
        let insideMultiLineComment = false;
        
        while (depth > 0 && index < sourceCode.length) {
            const character = sourceCode[index];
            const previousCharacter = index > 0 ? sourceCode[index - 1] : '';
            const nextCharacter = index < sourceCode.length - 1 ? sourceCode[index + 1] : '';
            
            if (!insideString && !insideTemplate && !insideMultiLineComment) {
                if (character === '/' && nextCharacter === '/') {
                    insideSingleLineComment = true;
                    index = index + 2;
                    continue;
                }
                if (character === '/' && nextCharacter === '*') {
                    insideMultiLineComment = true;
                    index = index + 2;
                    continue;
                }
            }
            
            if (insideSingleLineComment) {
                if (character === '\n') {
                    insideSingleLineComment = false;
                }
                index = index + 1;
                continue;
            }
            
            if (insideMultiLineComment) {
                if (character === '*' && nextCharacter === '/') {
                    insideMultiLineComment = false;
                    index = index + 2;
                    continue;
                }
                index = index + 1;
                continue;
            }
            
            if (character === '`' && previousCharacter !== '\\' && !insideString) {
                insideTemplate = !insideTemplate;
                index = index + 1;
                continue;
            }
            
            if (!insideTemplate && (character === '"' || character === "'") && previousCharacter !== '\\') {
                if (!insideString) {
                    insideString = true;
                    stringDelimiter = character;
                } else if (character === stringDelimiter) {
                    insideString = false;
                }
                index = index + 1;
                continue;
            }
            
            if (!insideString && !insideTemplate) {
                if (character === '{') {
                    depth = depth + 1;
                }
                if (character === '}') {
                    depth = depth - 1;
                }
            }
            
            if (depth === 0) {
                return index;
            }
            index = index + 1;
        }
        return sourceCode.length - 1;
    }
    
    // New helper method to track template string context
    static isInsideTemplateString(sourceCode, position) {
        let insideTemplate = false;
        let insideString = false;
        let stringDelimiter = '';
        let insideSingleLineComment = false;
        let insideMultiLineComment = false;
        
        for (let i = 0; i < position; i++) {
            const char = sourceCode[i];
            const prevChar = i > 0 ? sourceCode[i - 1] : '';
            const nextChar = i < sourceCode.length - 1 ? sourceCode[i + 1] : '';
            
            // Handle comments outside of strings/templates
            if (!insideString && !insideTemplate && !insideMultiLineComment) {
                if (char === '/' && nextChar === '/') {
                    insideSingleLineComment = true;
                    i++;
                    continue;
                }
                if (char === '/' && nextChar === '*') {
                    insideMultiLineComment = true;
                    i++;
                    continue;
                }
            }
            
            if (insideSingleLineComment) {
                if (char === '\n') {
                    insideSingleLineComment = false;
                }
                continue;
            }
            
            if (insideMultiLineComment) {
                if (char === '*' && nextChar === '/') {
                    insideMultiLineComment = false;
                    i++;
                    continue;
                }
                continue;
            }
            
            // Track template strings
            if (char === '`' && prevChar !== '\\' && !insideString) {
                insideTemplate = !insideTemplate;
                continue;
            }
            
            // Track regular strings (only when not in template)
            if (!insideTemplate && (char === '"' || char === "'") && prevChar !== '\\') {
                if (!insideString) {
                    insideString = true;
                    stringDelimiter = char;
                } else if (char === stringDelimiter) {
                    insideString = false;
                }
                continue;
            }
        }
        
        return insideTemplate;
    }
}

// ============================================================================
// CODE ANALYSIS MODULE
// ============================================================================
class CodeAnalyzer {

    static extractImports(sourceCode) {
        const imports = [];
        const regularExpression = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s*,?\s*)*\s*from\s+['"][^'"]+['"]\s*;?/g;
        let match;
        while ((match = regularExpression.exec(sourceCode)) !== null) {
            // Skip if inside template string
            if (BraceMatcher.isInsideTemplateString(sourceCode, match.index)) {
                continue;
            }
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

    static extractExports(sourceCode) {
        const exports = [];
        const patterns = [
            /export\s+default\s+(?:class|function|const|let|var)?\s*(\w+)?/g,
            /export\s+(?:const|let|var|function|class)\s+(\w+)/g,
            /export\s+\{[^}]+\}/g,
            /module\.exports\s*=\s*[^;]+;?/g
        ];
        
        for (const regularExpression of patterns) {
            let match;
            while ((match = regularExpression.exec(sourceCode)) !== null) {
                // Skip if inside template string
                if (BraceMatcher.isInsideTemplateString(sourceCode, match.index)) {
                    continue;
                }
                exports.push({
                    type: 'export',
                    name: match[1] || match[0].trim(),
                    start: match.index,
                    end: match.index + match[0].length,
                    content: match[0]
                });
            }
        }
        return exports;
    }

    static extractClasses(sourceCode) {
        const classes = [];
        const regularExpression = /class\s+(\w+)(?:\s+extends\s+(\w+))?\s*\{/g;
        let match;
        while ((match = regularExpression.exec(sourceCode)) !== null) {
            // Skip if inside template string
            if (BraceMatcher.isInsideTemplateString(sourceCode, match.index)) {
                continue;
            }
            const className = match[1];
            const extendsClass = match[2] || null;
            const start = match.index;
            const end = BraceMatcher.findMatchingBrace(sourceCode, match.index + match[0].length - 1) + 1;
            
            const classContent = sourceCode.substring(start, end);
            classes.push({
                type: 'class',
                name: className,
                extends: extendsClass,
                start: start,
                end: end,
                content: classContent,
                methods: this.extractClassMethods(classContent)
            });
        }
        return classes;
    }

    static extractFunctions(sourceCode) {
        const functions = [];
        const classRanges = this.extractClasses(sourceCode).map(classItem => ({
            start: classItem.start,
            end: classItem.end
        }));
        
        const isInsideAnyClass = (position) => {
            return classRanges.some(range => position > range.start && position < range.end);
        };
        
        const functionDeclarationRegex = /(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*\{/g;
        let match;
        while ((match = functionDeclarationRegex.exec(sourceCode)) !== null) {
            // Skip if inside template string or class
            if (BraceMatcher.isInsideTemplateString(sourceCode, match.index) || isInsideAnyClass(match.index)) {
                continue;
            }
            const start = match.index;
            const end = BraceMatcher.findMatchingBrace(sourceCode, match.index + match[0].length - 1) + 1;
            functions.push({
                type: 'function',
                name: match[1],
                start: start,
                end: end,
                content: sourceCode.substring(start, end),
                isAsync: match[0].includes('async')
            });
        }
        
        const arrowFunctionRegex = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g;
        while ((match = arrowFunctionRegex.exec(sourceCode)) !== null) {
            // Skip if inside template string or class
            if (BraceMatcher.isInsideTemplateString(sourceCode, match.index) || isInsideAnyClass(match.index)) {
                continue;
            }
            const start = match.index;
            const end = BraceMatcher.findMatchingBrace(sourceCode, match.index + match[0].length - 1) + 1;
            functions.push({
                type: 'function',
                name: match[1],
                start: start,
                end: end,
                content: sourceCode.substring(start, end),
                isAsync: match[0].includes('async'),
                isArrow: true
            });
        }
        return functions;
    }

    static extractVariables(sourceCode) {
        const variables = [];
        const classRanges = this.extractClasses(sourceCode).map(classItem => ({
            start: classItem.start,
            end: classItem.end
        }));
        const functionRanges = this.extractFunctions(sourceCode).map(functionItem => ({
            start: functionItem.start,
            end: functionItem.end
        }));
        
        const isInsideStructure = (position) => {
            return classRanges.some(range => position > range.start && position < range.end) ||
                   functionRanges.some(range => position > range.start && position < range.end);
        };
        
        const regularExpression = /(?:const|let|var)\s+(\w+)\s*=\s*[^;]+;?/g;
        let match;
        while ((match = regularExpression.exec(sourceCode)) !== null) {
            // Skip if inside template string, class, function, or is arrow/function declaration
            if (BraceMatcher.isInsideTemplateString(sourceCode, match.index) || 
                isInsideStructure(match.index) || 
                match[0].includes('=>') || 
                match[0].includes('function')) {
                continue;
            }
            variables.push({
                type: 'variable',
                name: match[1],
                start: match.index,
                end: match.index + match[0].length,
                content: match[0].trim()
            });
        }
        return variables;
    }

    static extractComments(sourceCode) {
        const comments = [];
        const patterns = [
            { regularExpression: /\/\/.*$/gm, type: 'single-line' },
            { regularExpression: /\/\*[\s\S]*?\*\//g, type: 'multi-line' }
        ];
        
        for (const { regularExpression, type } of patterns) {
            let match;
            while ((match = regularExpression.exec(sourceCode)) !== null) {
                // Skip if inside template string
                if (BraceMatcher.isInsideTemplateString(sourceCode, match.index)) {
                    continue;
                }
                
                const isJSDoc = match[0].includes('/**') || 
                               (type === 'multi-line' && match[0].trimStart().startsWith('/**'));
                
                comments.push({
                    type: 'comment',
                    commentType: type,
                    isJSDoc: isJSDoc,
                    name: isJSDoc ? 'JSDoc' : 'Comment',
                    start: match.index,
                    end: match.index + match[0].length,
                    content: match[0]
                });
            }
        }
        return comments;
    }

    static extractJSDocComments(sourceCode) {
        return this.extractComments(sourceCode).filter(comment => comment.isJSDoc);
    }

    static extractClassMethods(classCode) {
        const methods = [];
        const regularExpression = /(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/g;
        let match;
        while ((match = regularExpression.exec(classCode)) !== null) {
            if (match[1] !== 'constructor') {
                const start = match.index;
                const end = BraceMatcher.findMatchingBrace(classCode, match.index + match[0].length - 1) + 1;
                methods.push({
                    name: match[1],
                    start: start,
                    end: end,
                    content: classCode.substring(start, end)
                });
            }
        }
        return methods;
    }

    static getAllParts(sourceCode) {
        const allParts = [
            ...this.extractImports(sourceCode),
            ...this.extractExports(sourceCode),
            ...this.extractClasses(sourceCode),
            ...this.extractFunctions(sourceCode),
            ...this.extractVariables(sourceCode),
            ...this.extractComments(sourceCode)
        ];
        allParts.sort(function(first, second) {
            return first.start - second.start;
        });
        return allParts;
    }

    static analyzeCode(sourceCode) {
        const comments = this.extractComments(sourceCode);
        return {
            imports: this.extractImports(sourceCode),
            exports: this.extractExports(sourceCode),
            classes: this.extractClasses(sourceCode),
            functions: this.extractFunctions(sourceCode),
            variables: this.extractVariables(sourceCode),
            comments: comments,
            jsdocComments: comments.filter(function(comment) { return comment.isJSDoc; }),
            allParts: function() { return CodeAnalyzer.getAllParts(sourceCode); }
        };
    }
}

// ============================================================================
// CONFIGURATION MANAGER
// ============================================================================
class ConfigManager {
    static #configurationFilePath = '';

    static initializeConfigurationPath(filePath) {
        if (!this.#configurationFilePath) {
            this.#configurationFilePath = path.join(path.dirname(filePath), '.code-parser-configs.json');
        }
        return this.#configurationFilePath;
    }

    static getConfigurationFilePath() {
        return this.#configurationFilePath;
    }
    
    static loadConfigurations() {
        const configurationFile = this.getConfigurationFilePath();
        if (fs.existsSync(configurationFile)) {
            try {
                const data = fs.readFileSync(configurationFile, 'utf-8');
                return JSON.parse(data);
            } catch (error) {
                console.error('Warning: Error reading configuration file:', error.message);
                return { configs: {} };
            }
        }
        return { configs: {} };
    }
    
    static saveConfigurations(configurations) {
        const configurationFile = this.getConfigurationFilePath();
        try {
            fs.writeFileSync(configurationFile, JSON.stringify(configurations, null, 2));
            return true;
        } catch (error) {
            console.error('Warning: Error saving configuration file:', error.message);
            return false;
        }
    }
    
    static saveConfiguration(configurationName, options) {
        const configurations = this.loadConfigurations();
        configurations.configs[configurationName] = {
            name: configurationName,
            created: new Date().toISOString(),
            options: options
        };
        return this.saveConfigurations(configurations);
    }
}

// ============================================================================
// MERGE SCRIPT GENERATOR - DIFF-BASED RECONSTRUCTION
// ============================================================================
class MergeScriptGenerator {

    static createMergeScript(removedParts, originalCode) {
        
        // Build a complete segment map of the original file
        // Each segment is either KEPT or REMOVED
        const sortedParts = [...removedParts].sort(function(a, b) {
            return a.start - b.start;
        });
        
        const segments = [];
        let currentPosition = 0;
        
        for (const part of sortedParts) {
            // Kept segment before this removed part
            if (part.start > currentPosition) {
                segments.push({
                    type: 'kept',
                    start: currentPosition,
                    end: part.start,
                    content: originalCode.substring(currentPosition, part.start)
                });
            }
            // Removed segment
            segments.push({
                type: 'removed',
                start: part.start,
                end: part.end,
                content: part.content,
                name: part.name,
                partType: part.type
            });
            currentPosition = part.end;
        }
        
        // Final kept segment after last removed part
        if (currentPosition < originalCode.length) {
            segments.push({
                type: 'kept',
                start: currentPosition,
                end: originalCode.length,
                content: originalCode.substring(currentPosition)
            });
        }
        
        // Build the segments data for the merge script
        const segmentsData = segments.map(function(segment, index) {
            if (segment.type === 'removed') {
                return {
                    type: 'removed',
                    name: segment.name,
                    partType: segment.partType,
                    content: segment.content,
                    originalStart: segment.start,
                    originalEnd: segment.end
                };
            } else {
                return {
                    type: 'kept',
                    content: segment.content,
                    originalStart: segment.start,
                    originalEnd: segment.end
                };
            }
        });

        const mergeScriptContent = '#!/usr/bin/env node\n' +
'/**\n' +
' * ============================================================================\n' +
' * DIFF-BASED RECONSTRUCTION MERGE SCRIPT\n' +
' * ============================================================================\n' +
' * Generated: ' + new Date().toISOString() + '\n' +
' * \n' +
' * This script reconstructs the original file by tracking EXACT byte positions.\n' +
' * The approach:\n' +
' *   1. The original file is divided into KEPT and REMOVED segments\n' +
' *   2. The filtered file contains the KEPT segments in order\n' +
' *   3. This script reinserts REMOVED segments at their correct positions\n' +
' *   4. Uses content fingerprinting to find exact insertion points\n' +
' * \n' +
' * Usage:\n' +
' *   node merge-script.js <filtered-file.js> [options]\n' +
' * \n' +
' * Options:\n' +
' *   --output <file>   Output file (default: <input>_merged.js)\n' +
' *   --dry-run         Preview only\n' +
' *   --verbose         Show detailed progress\n' +
' *   --force           Skip confirmation\n' +
' */\n' +
'\n' +
'import fs from \'fs\';\n' +
'import path from \'path\';\n' +
'\n' +
'// ============================================================\n' +
'// SEGMENTS DATA\n' +
'// ============================================================\n' +
'const segments = ' + JSON.stringify(segmentsData, null, 2) + ';\n' +
'\n' +
'// ============================================================\n' +
'// CONTENT FINGERPRINTING\n' +
'// ============================================================\n' +
'function createFingerprint(text, length) {\n' +
'    const cleanText = text.replace(/\\s+/g, \' \').trim();\n' +
'    if (cleanText.length <= length) {\n' +
'        return cleanText;\n' +
'    }\n' +
'    return cleanText.substring(0, length);\n' +
'}\n' +
'\n' +
'function findFingerprintInCode(code, fingerprint) {\n' +
'    const normalizedCode = code.replace(/\\s+/g, \' \').trim();\n' +
'    const index = normalizedCode.indexOf(fingerprint);\n' +
'    if (index === -1) {\n' +
'        return -1;\n' +
'    }\n' +
'    // Map back to original position\n' +
'    let originalIndex = 0;\n' +
'    let normalizedIndex = 0;\n' +
'    while (normalizedIndex < index && originalIndex < code.length) {\n' +
'        if (/\\s/.test(code[originalIndex])) {\n' +
'            while (originalIndex < code.length && /\\s/.test(code[originalIndex])) {\n' +
'                originalIndex = originalIndex + 1;\n' +
'            }\n' +
'            if (normalizedIndex > 0) {\n' +
'                normalizedIndex = normalizedIndex + 1;\n' +
'            }\n' +
'        } else {\n' +
'            originalIndex = originalIndex + 1;\n' +
'            normalizedIndex = normalizedIndex + 1;\n' +
'        }\n' +
'    }\n' +
'    return originalIndex;\n' +
'}\n' +
'\n' +
'// ============================================================\n' +
'// FIND INSERTION POINT BY SURROUNDING CONTEXT\n' +
'// ============================================================\n' +
'function findInsertionPoint(code, segmentIndex, allSegments) {\n' +
'    // Strategy 1: Use the KEPT segment AFTER this removed segment\n' +
'    // Find the next KEPT segment\n' +
'    for (let i = segmentIndex + 1; i < allSegments.length; i++) {\n' +
'        if (allSegments[i].type === \'kept\' && allSegments[i].content.trim().length > 20) {\n' +
'            const fingerprint = createFingerprint(allSegments[i].content, 100);\n' +
'            const position = findFingerprintInCode(code, fingerprint);\n' +
'            if (position >= 0) {\n' +
'                return {\n' +
'                    position: position,\n' +
'                    confidence: \'HIGH\',\n' +
'                    method: \'next-kept-segment\'\n' +
'                };\n' +
'            }\n' +
'            break;\n' +
'        }\n' +
'    }\n' +
'    \n' +
'    // Strategy 2: Use the KEPT segment BEFORE this removed segment\n' +
'    for (let i = segmentIndex - 1; i >= 0; i--) {\n' +
'        if (allSegments[i].type === \'kept\' && allSegments[i].content.trim().length > 20) {\n' +
'            const fingerprint = createFingerprint(allSegments[i].content, 100);\n' +
'            const position = findFingerprintInCode(code, fingerprint);\n' +
'            if (position >= 0) {\n' +
'                // Insert AFTER this kept segment\n' +
'                const keptContent = allSegments[i].content;\n' +
'                // Find the end of this kept content in the actual code\n' +
'                let keptEnd = position;\n' +
'                const normalizedKept = keptContent.replace(/\\s+/g, \' \').trim();\n' +
'                let matchedChars = 0;\n' +
'                let codePos = position;\n' +
'                while (matchedChars < normalizedKept.length && codePos < code.length) {\n' +
'                    if (/\\s/.test(code[codePos])) {\n' +
'                        codePos = codePos + 1;\n' +
'                    } else {\n' +
'                        codePos = codePos + 1;\n' +
'                        matchedChars = matchedChars + 1;\n' +
'                    }\n' +
'                }\n' +
'                return {\n' +
'                    position: codePos,\n' +
'                    confidence: \'HIGH\',\n' +
'                    method: \'previous-kept-segment\'\n' +
'                };\n' +
'            }\n' +
'            break;\n' +
'        }\n' +
'    }\n' +
'    \n' +
'    // Strategy 3: Use the removed segment\'s own content\n' +
'    const removedSegment = allSegments[segmentIndex];\n' +
'    const firstLine = removedSegment.content.split(\'\\n\')[0].trim();\n' +
'    if (firstLine.length > 10) {\n' +
'        const index = code.indexOf(firstLine);\n' +
'        if (index >= 0) {\n' +
'            return {\n' +
'                position: index,\n' +
'                confidence: \'MEDIUM\',\n' +
'                method: \'content-first-line\'\n' +
'            };\n' +
'        }\n' +
'    }\n' +
'    \n' +
'    // Strategy 4: End of file\n' +
'    return {\n' +
'        position: code.length,\n' +
'        confidence: \'FALLBACK\',\n' +
'        method: \'end-of-file\'\n' +
'    };\n' +
'}\n' +
'\n' +
'// ============================================================\n' +
'// RECONSTRUCT ORIGINAL FILE\n' +
'// ============================================================\n' +
'function reconstructOriginalFile(filteredCode, verbose) {\n' +
'    // Build the list of segments in original order\n' +
'    const originalOrder = [...segments];\n' +
'    \n' +
'    let result = filteredCode;\n' +
'    const report = [];\n' +
'    let insertedCount = 0;\n' +
'    let failedCount = 0;\n' +
'    \n' +
'    // Process removed segments in REVERSE original order\n' +
'    // This ensures positions of not-yet-inserted segments are preserved\n' +
'    const removedSegments = [];\n' +
'    for (let i = 0; i < originalOrder.length; i++) {\n' +
'        if (originalOrder[i].type === \'removed\') {\n' +
'            removedSegments.push({ segment: originalOrder[i], index: i });\n' +
'        }\n' +
'    }\n' +
'    \n' +
'    // Sort by original position DESCENDING\n' +
'    removedSegments.sort(function(a, b) {\n' +
'        return b.segment.originalStart - a.segment.originalStart;\n' +
'    });\n' +
'    \n' +
'    if (verbose) {\n' +
'        console.log(\'\');\n' +
'        console.log(\'Reconstructing original file from \' + removedSegments.length + \' removed segments...\');\n' +
'        console.log(\'\');\n' +
'    }\n' +
'    \n' +
'    for (let i = 0; i < removedSegments.length; i++) {\n' +
'        const { segment, index: originalIndex } = removedSegments[i];\n' +
'        const progress = \'[\' + (i + 1) + \'/\' + removedSegments.length + \']\';\n' +
'        \n' +
'        if (verbose) {\n' +
'            process.stdout.write(progress + \' \' + segment.partType + \': \' + segment.name + \' ... \');\n' +
'        }\n' +
'        \n' +
'        // Check if already present\n' +
'        const normalizedContent = segment.content.replace(/\\s+/g, \' \').trim();\n' +
'        const normalizedResult = result.replace(/\\s+/g, \' \').trim();\n' +
'        \n' +
'        if (normalizedContent.length > 20 && normalizedResult.includes(normalizedContent)) {\n' +
'            if (verbose) console.log(\'SKIP (already present)\');\n' +
'            report.push({ name: segment.name, type: segment.partType, status: \'already-present\' });\n' +
'            continue;\n' +
'        }\n' +
'        \n' +
'        const insertion = findInsertionPoint(result, originalIndex, originalOrder);\n' +
'        \n' +
'        if (insertion && insertion.position >= 0) {\n' +
'            const before = result.substring(0, insertion.position);\n' +
'            const after = result.substring(insertion.position);\n' +
'            \n' +
'            // Clean spacing\n' +
'            const cleanBefore = before.replace(/\\n+$/, \'\\n\\n\');\n' +
'            const cleanAfter = after.replace(/^\\n+/, \'\');\n' +
'            const cleanContent = segment.content.trim();\n' +
'            \n' +
'            result = cleanBefore + cleanContent + \'\\n\\n\' + cleanAfter;\n' +
'            insertedCount = insertedCount + 1;\n' +
'            \n' +
'            if (verbose) {\n' +
'                console.log(\'OK (\' + insertion.method + \', \' + insertion.confidence + \')\');\n' +
'            }\n' +
'            \n' +
'            report.push({\n' +
'                name: segment.name,\n' +
'                type: segment.partType,\n' +
'                status: \'inserted\',\n' +
'                method: insertion.method,\n' +
'                confidence: insertion.confidence\n' +
'            });\n' +
'        } else {\n' +
'            failedCount = failedCount + 1;\n' +
'            if (verbose) console.log(\'FAILED\');\n' +
'            report.push({ name: segment.name, type: segment.partType, status: \'failed\' });\n' +
'        }\n' +
'    }\n' +
'    \n' +
'    // Final cleanup\n' +
'    result = result.replace(/\\n{4,}/g, \'\\n\\n\\n\');\n' +
'    result = result.trimStart() + \'\\n\';\n' +
'    \n' +
'    return {\n' +
'        code: result,\n' +
'        report: report,\n' +
'        inserted: insertedCount,\n' +
'        failed: failedCount\n' +
'    };\n' +
'}\n' +
'\n' +
'// ============================================================\n' +
'// MAIN\n' +
'// ============================================================\n' +
'function main() {\n' +
'    const args = process.argv.slice(2);\n' +
'    \n' +
'    if (args.length === 0 || args.includes(\'--help\') || args.includes(\'-h\')) {\n' +
'        console.log(\'Diff-Based Reconstruction Merge Script\');\n' +
'        console.log(\'=\'.repeat(50));\n' +
'        console.log(\'Usage: node merge-script.js <filtered-file.js> [options]\');\n' +
'        console.log(\'  --output <file>   Output file\');\n' +
'        console.log(\'  --dry-run         Preview only\');\n' +
'        console.log(\'  --verbose         Show details\');\n' +
'        console.log(\'  --force           Skip confirmation\');\n' +
'        process.exit(0);\n' +
'    }\n' +
'    \n' +
'    const targetFile = args[0];\n' +
'    const outputFile = args.includes(\'--output\')\n' +
'        ? args[args.indexOf(\'--output\') + 1]\n' +
'        : targetFile.replace(\'.js\', \'_merged.js\');\n' +
'    const dryRun = args.includes(\'--dry-run\');\n' +
'    const verbose = args.includes(\'--verbose\');\n' +
'    const force = args.includes(\'--force\');\n' +
'    \n' +
'    if (!fs.existsSync(targetFile)) {\n' +
'        console.error(\'ERROR: File not found: \' + targetFile);\n' +
'        process.exit(1);\n' +
'    }\n' +
'    \n' +
'    console.log(\'Diff-Based Reconstruction Merge\');\n' +
'    console.log(\'=\'.repeat(50));\n' +
'    console.log(\'Target: \' + path.basename(targetFile));\n' +
'    \n' +
'    const removedCount = segments.filter(function(s) { return s.type === \'removed\'; }).length;\n' +
'    console.log(\'Segments to reinsert: \' + removedCount);\n' +
'    \n' +
'    if (!dryRun && !force) {\n' +
'        console.log(\'\');\n' +
'        console.log(\'Waiting 2 seconds... (Ctrl+C to cancel)\');\n' +
'        const start = Date.now();\n' +
'        while (Date.now() - start < 2000) {}\n' +
'    }\n' +
'    \n' +
'    const code = fs.readFileSync(targetFile, \'utf-8\');\n' +
'    console.log(\'\');\n' +
'    console.log(\'Reconstructing...\');\n' +
'    \n' +
'    const result = reconstructOriginalFile(code, verbose);\n' +
'    \n' +
'    console.log(\'\');\n' +
'    console.log(\'=\'.repeat(50));\n' +
'    console.log(\'RESULTS\');\n' +
'    console.log(\'=\'.repeat(50));\n' +
'    console.log(\'Inserted: \' + result.inserted);\n' +
'    console.log(\'Failed:   \' + result.failed);\n' +
'    console.log(\'Lines:    \' + result.code.split(\'\\n\').length);\n' +
'    \n' +
'    if (result.failed > 0) {\n' +
'        console.log(\'\');\n' +
'        console.log(\'FAILED (manual insertion needed):\');\n' +
'        for (const r of result.report) {\n' +
'            if (r.status === \'failed\') {\n' +
'                console.log(\'  - [\' + r.type + \'] \' + r.name);\n' +
'            }\n' +
'        }\n' +
'    }\n' +
'    \n' +
'    if (verbose) {\n' +
'        console.log(\'\');\n' +
'        console.log(\'DETAIL:\');\n' +
'        for (const r of result.report) {\n' +
'            const icon = r.status === \'inserted\' ? \'+\' : r.status === \'already-present\' ? \'.\' : \'!\';\n' +
'            console.log(\'  \' + icon + \' [\' + r.type + \'] \' + r.name +\n' +
'                       (r.method ? \' (\' + r.method + \')\' : \'\'));\n' +
'        }\n' +
'    }\n' +
'    \n' +
'    if (dryRun) {\n' +
'        console.log(\'\');\n' +
'        console.log(\'DRY RUN - No file written\');\n' +
'    } else {\n' +
'        fs.writeFileSync(outputFile, result.code);\n' +
'        console.log(\'\');\n' +
'        console.log(\'Output: \' + outputFile);\n' +
'        console.log(\'Size: \' + (result.code.length / 1024).toFixed(1) + \' KB\');\n' +
'    }\n' +
'    \n' +
'    console.log(\'\');\n' +
'    console.log(\'Done.\');\n' +
'    process.exit(0);\n' +
'}\n' +
'\n' +
'main();\n';

        return mergeScriptContent;
    }
}

// ============================================================================
// CODE FILTER
// ============================================================================
class CodeFilter {

    static createFilteredCode(sourceCode, analysis, options) {
        const {
            includeImports = true,
            includeExports = true,
            includeClasses = [],
            excludeClasses = [],
            includeFunctions = [],
            excludeFunctions = [],
            includeVariables = [],
            excludeVariables = [],
            removeAllComments = false,
            removeOnlyJSDoc = false,
            mode = 'exclude',
            generateMergeScript = false,
            mergeScriptPath = null
        } = options || {};
    
        const originalCode = sourceCode;
        let partsToRemove = [];
        
        if (!includeImports) {
            partsToRemove.push(...analysis.imports);
        }
        
        if (!includeExports) {
            partsToRemove.push(...analysis.exports);
        }
    
        if (mode === 'include') {
            if (includeClasses.length > 0) {
                const classesToRemove = analysis.classes.filter(function(classItem) {
                    return !includeClasses.includes(classItem.name);
                });
                partsToRemove.push(...classesToRemove);
            }
            if (includeFunctions.length > 0) {
                const functionsToRemove = analysis.functions.filter(function(functionItem) {
                    return !includeFunctions.includes(functionItem.name);
                });
                partsToRemove.push(...functionsToRemove);
            }
            if (includeVariables.length > 0) {
                const variablesToRemove = analysis.variables.filter(function(variableItem) {
                    return !includeVariables.includes(variableItem.name);
                });
                partsToRemove.push(...variablesToRemove);
            }
        } else {
            if (excludeClasses.length > 0) {
                const classesToRemove = analysis.classes.filter(function(classItem) {
                    return excludeClasses.includes(classItem.name);
                });
                partsToRemove.push(...classesToRemove);
            }
            if (excludeFunctions.length > 0) {
                const functionsToRemove = analysis.functions.filter(function(functionItem) {
                    return excludeFunctions.includes(functionItem.name);
                });
                partsToRemove.push(...functionsToRemove);
            }
            if (excludeVariables.length > 0) {
                const variablesToRemove = analysis.variables.filter(function(variableItem) {
                    return excludeVariables.includes(variableItem.name);
                });
                partsToRemove.push(...variablesToRemove);
            }
        }

        if (removeAllComments) {
            partsToRemove.push(...analysis.comments);
        } else if (removeOnlyJSDoc) {
            partsToRemove.push(...analysis.jsdocComments);
        }
    
        // Remove duplicates based on position
        const seenPositions = new Set();
        partsToRemove = partsToRemove.filter(function(part) {
            const key = part.start + '-' + part.end;
            if (seenPositions.has(key)) {
                return false;
            }
            seenPositions.add(key);
            return true;
        });
    
        // Sort by start position
        partsToRemove.sort(function(first, second) {
            return first.start - second.start;
        });
        
        // Merge overlapping ranges
        const mergedRanges = [];
        for (const part of partsToRemove) {
            if (mergedRanges.length === 0) {
                mergedRanges.push({ start: part.start, end: part.end });
            } else {
                const lastRange = mergedRanges[mergedRanges.length - 1];
                if (part.start <= lastRange.end) {
                    lastRange.end = Math.max(lastRange.end, part.end);
                } else {
                    mergedRanges.push({ start: part.start, end: part.end });
                }
            }
        }
        
        // Build filtered code
        let filteredCode = '';
        let currentPosition = 0;
        
        for (const range of mergedRanges) {
            filteredCode = filteredCode + originalCode.substring(currentPosition, range.start);
            currentPosition = range.end;
        }
        
        filteredCode = filteredCode + originalCode.substring(currentPosition);
        filteredCode = filteredCode.replace(/\n{4,}/g, '\n\n\n');
        
        // Generate merge script
        let mergeScriptGenerated = false;
        let actualMergeScriptPath = null;
        
        if (generateMergeScript && partsToRemove.length > 0) {
            const mergeScriptContent = MergeScriptGenerator.createMergeScript(partsToRemove, originalCode);
            actualMergeScriptPath = mergeScriptPath || 'merge_script.js';
            fs.writeFileSync(actualMergeScriptPath, mergeScriptContent);
            mergeScriptGenerated = true;
        }
        
        return {
            code: filteredCode,
            removedParts: partsToRemove,
            mergeScriptGenerated: mergeScriptGenerated,
            mergeScriptPath: actualMergeScriptPath
        };
    }
}

// ============================================================================
// INTERACTIVE MENU
// ============================================================================
class InteractiveMenu {

    constructor(filePath) {
        this.filePath = filePath;
        this.terminal = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: true
        });
        this.sourceCode = fs.readFileSync(filePath, 'utf-8');
        this.analysis = CodeAnalyzer.analyzeCode(this.sourceCode);
    }

    async askQuestion(prompt) {
        return new Promise(function(resolve) {
            this.terminal.question(prompt, resolve);
        }.bind(this));
    }

    async displayMainMenu() {
        let running = true;
        
        while (running) {
            console.clear();
            console.log('JavaScript Code Parser');
            console.log('='.repeat(50));
            console.log('File: ' + path.basename(this.filePath));
            console.log('Size: ' + this.sourceCode.length + ' chars, ' + this.sourceCode.split('\n').length + ' lines');
            console.log('');
            console.log('1. Show all parts');
            console.log('2. Show classes');
            console.log('3. Show functions');
            console.log('4. Show variables');
            console.log('5. Show comments');
            console.log('6. Filter (exclude mode)');
            console.log('7. Filter (include mode)');
            console.log('8. Export parts');
            console.log('9. Statistics');
            console.log('10. Configurations');
            console.log('0. Exit');

            const choice = await this.askQuestion('\nSelect option: ');
            console.clear();
            
            switch (choice) {
                case '1':
                    this.showAllParts();
                    break;
                case '2':
                    this.showClasses();
                    break;
                case '3':
                    this.showFunctions();
                    break;
                case '4':
                    this.showVariables();
                    break;
                case '5':
                    this.showComments();
                    break;
                case '6':
                    await this.handleFilter('exclude');
                    break;
                case '7':
                    await this.handleFilter('include');
                    break;
                case '8':
                    await this.handleExport();
                    break;
                case '9':
                    this.showStatistics();
                    break;
                case '10':
                    await this.handleConfigurations();
                    break;
                case '0':
                    console.log('\nGoodbye!');
                    this.terminal.close();
                    running = false;
                    process.exit(0);
                    break;
                default:
                    console.log('Invalid option.');
            }
            
            if (choice !== '0') {
                await this.askQuestion('\nPress Enter to continue...');
            }
        }
    }

    showAllParts() {
        const allParts = this.analysis.allParts();
        console.log('All Parts (' + allParts.length + '):');
        console.log('='.repeat(50));
        for (let index = 0; index < allParts.length; index++) {
            const part = allParts[index];
            console.log((index + 1) + '. [' + part.type.toUpperCase() + '] ' + (part.name || 'unnamed') + 
                       ' (' + part.content.length + ' chars)');
        }
    }

    showClasses() {
        console.log('Classes (' + this.analysis.classes.length + '):');
        console.log('='.repeat(50));
        if (this.analysis.classes.length === 0) {
            console.log('None');
            return;
        }
        for (let index = 0; index < this.analysis.classes.length; index++) {
            const classItem = this.analysis.classes[index];
            const extendsText = classItem.extends ? ' extends ' + classItem.extends : '';
            console.log((index + 1) + '. ' + classItem.name + extendsText + 
                       ' (' + classItem.methods.length + ' methods, ' + classItem.content.length + ' chars)');
        }
    }

    showFunctions() {
        console.log('Functions (' + this.analysis.functions.length + '):');
        console.log('='.repeat(50));
        if (this.analysis.functions.length === 0) {
            console.log('None');
            return;
        }
        for (let index = 0; index < this.analysis.functions.length; index++) {
            const functionItem = this.analysis.functions[index];
            const flags = [];
            if (functionItem.isAsync) flags.push('async');
            if (functionItem.isArrow) flags.push('arrow');
            const flagsText = flags.length > 0 ? ' (' + flags.join(', ') + ')' : '';
            console.log((index + 1) + '. ' + functionItem.name + flagsText + 
                       ' (' + functionItem.content.length + ' chars)');
        }
    }

    showVariables() {
        console.log('Variables (' + this.analysis.variables.length + '):');
        console.log('='.repeat(50));
        if (this.analysis.variables.length === 0) {
            console.log('None');
            return;
        }
        for (let index = 0; index < this.analysis.variables.length; index++) {
            const variableItem = this.analysis.variables[index];
            console.log((index + 1) + '. ' + variableItem.name + ' (' + variableItem.content.length + ' chars)');
        }
    }

    showComments() {
        console.log('Comments:');
        const regularComments = this.analysis.comments.filter(function(c) { return !c.isJSDoc; });
        const jsdocComments = this.analysis.jsdocComments;
        console.log('  Regular: ' + regularComments.length);
        console.log('  JSDoc:   ' + jsdocComments.length);
    }

    showStatistics() {
        console.log('Statistics');
        console.log('='.repeat(50));
        console.log('Classes:    ' + this.analysis.classes.length);
        console.log('Functions:  ' + this.analysis.functions.length);
        console.log('Variables:  ' + this.analysis.variables.length);
        console.log('Imports:    ' + this.analysis.imports.length);
        console.log('Exports:    ' + this.analysis.exports.length);
        console.log('Comments:   ' + this.analysis.comments.length);
        console.log('Total:      ' + this.sourceCode.length + ' chars, ' + this.sourceCode.split('\n').length + ' lines');
    }

    async selectMultipleItems(items, itemType) {
        if (items.length === 0) {
            console.log('\nNo ' + itemType + ' available.');
            return [];
        }
        
        console.log('\nAvailable ' + itemType + ':');
        console.log('-'.repeat(50));
        for (let index = 0; index < items.length; index++) {
            console.log('  ' + (index + 1) + '. ' + items[index].name);
        }
        console.log('\n  0 = done, a = all, n = none');
        
        const selected = new Set();
        let selecting = true;
        
        while (selecting) {
            const choice = await this.askQuestion('\nSelect ' + itemType + ': ');
            
            if (choice === '0') {
                selecting = false;
            } else if (choice.toLowerCase() === 'a') {
                for (const item of items) {
                    selected.add(item.name);
                }
                console.log('  All selected (' + selected.size + ' items)');
                selecting = false;
            } else if (choice.toLowerCase() === 'n') {
                selected.clear();
                console.log('  None selected');
                selecting = false;
            } else {
                const number = parseInt(choice);
                if (isNaN(number) || number < 1 || number > items.length) {
                    console.log('  Invalid');
                } else {
                    const item = items[number - 1];
                    if (selected.has(item.name)) {
                        selected.delete(item.name);
                        console.log('  - ' + item.name);
                    } else {
                        selected.add(item.name);
                        console.log('  + ' + item.name);
                    }
                    console.log('  Selected: ' + selected.size);
                }
            }
        }
        
        return Array.from(selected);
    }

    async handleFilter(mode) {
        const isExclude = mode === 'exclude';
        console.log(isExclude ? 'Filter (Exclude Mode)' : 'Filter (Include Mode)');
        console.log('='.repeat(50));
        
        const selectedClasses = await this.selectMultipleItems(this.analysis.classes, 'classes');
        const selectedFunctions = await this.selectMultipleItems(this.analysis.functions, 'functions');
        const selectedVariables = await this.selectMultipleItems(this.analysis.variables, 'variables');
        
        console.log('\nComments: 1=Keep  2=Remove all  3=Remove JSDoc');
        const commentChoice = await this.askQuestion('Select (default 1): ');
        
        const generateMerge = await this.askQuestion('\nGenerate merge script? (y/n, default y): ');
        
        const options = {
            mode: mode,
            removeAllComments: commentChoice === '2',
            removeOnlyJSDoc: commentChoice === '3',
            generateMergeScript: generateMerge.toLowerCase() !== 'n'
        };
        
        if (isExclude) {
            options.excludeClasses = selectedClasses;
            options.excludeFunctions = selectedFunctions;
            options.excludeVariables = selectedVariables;
        } else {
            options.includeClasses = selectedClasses;
            options.includeFunctions = selectedFunctions;
            options.includeVariables = selectedVariables;
        }
        
        console.log('\nProcessing...');
        const result = CodeFilter.createFilteredCode(this.sourceCode, this.analysis, options);
        
        const outputFile = this.filePath.replace('.js', isExclude ? '_filtered.js' : '_included.js');
        fs.writeFileSync(outputFile, result.code);
        
        console.log('\n' + '='.repeat(50));
        console.log('Saved: ' + outputFile);
        console.log('Original: ' + this.sourceCode.length + ' chars, ' + this.sourceCode.split('\n').length + ' lines');
        console.log('Result:   ' + result.code.length + ' chars, ' + result.code.split('\n').length + ' lines');
        console.log('Removed:  ' + result.removedParts.length + ' parts');
        console.log('Lines removed: ' + (this.sourceCode.split('\n').length - result.code.split('\n').length));
        
        if (result.removedParts.length > 0) {
            console.log('\nRemoved items:');
            for (const part of result.removedParts) {
                console.log('  - [' + part.type + '] ' + part.name + ' (' + part.content.length + ' chars)');
            }
        }
        
        if (result.mergeScriptGenerated) {
            console.log('\nMerge script: ' + result.mergeScriptPath);
        }
        
        const saveConfig = await this.askQuestion('\nSave configuration? (y/n, default y): ');
        if (saveConfig.toLowerCase() !== 'n') {
            const configName = await this.askQuestion('Configuration name: ');
            if (configName.trim()) {
                ConfigManager.saveConfiguration(configName.trim(), options);
                console.log('Saved: ' + configName.trim());
            }
        }
    }

    async handleExport() {
        console.log('Export Parts');
        const allParts = this.analysis.allParts();
        for (let index = 0; index < allParts.length; index++) {
            const part = allParts[index];
            console.log('  ' + (index + 1) + '. [' + part.type.toUpperCase() + '] ' + (part.name || 'unnamed'));
        }
        
        const numbersInput = await this.askQuestion('\nNumbers (comma-separated): ');
        const indices = numbersInput.split(',').map(function(n) { return parseInt(n.trim()) - 1; }).filter(function(n) { return !isNaN(n); });
        const selectedParts = indices.map(function(i) { return allParts[i]; }).filter(Boolean);
        
        if (selectedParts.length > 0) {
            const exportContent = selectedParts.map(function(p) { return p.content; }).join('\n\n');
            const outputFile = this.filePath.replace('.js', '_exported.js');
            fs.writeFileSync(outputFile, exportContent);
            console.log('Exported ' + selectedParts.length + ' parts to: ' + outputFile);
        } else {
            console.log('No valid parts selected');
        }
    }

    async handleConfigurations() {
        const configurations = ConfigManager.loadConfigurations();
        const configNames = Object.keys(configurations.configs);
        
        let managing = true;
        
        while (managing) {
            console.clear();
            console.log('Configuration Management');
            console.log('1. List  2. Apply  3. Delete  0. Back');
            const choice = await this.askQuestion('\nSelect: ');
            
            if (choice === '0') {
                managing = false;
                break;
            }
            
            console.clear();
            
            if (choice === '1') {
                if (configNames.length === 0) {
                    console.log('No configurations saved.');
                } else {
                    for (let index = 0; index < configNames.length; index++) {
                        const name = configNames[index];
                        console.log((index + 1) + '. ' + name + ' (' + configurations.configs[name].options.mode + ')');
                    }
                }
            } else if (choice === '2') {
                if (configNames.length === 0) {
                    console.log('No configurations.');
                } else {
                    for (let index = 0; index < configNames.length; index++) {
                        console.log((index + 1) + '. ' + configNames[index]);
                    }
                    const selection = await this.askQuestion('\nSelect: ');
                    const index = parseInt(selection) - 1;
                    if (index >= 0 && index < configNames.length) {
                        const options = configurations.configs[configNames[index]].options;
                        const result = CodeFilter.createFilteredCode(this.sourceCode, this.analysis, options);
                        const outputFile = this.filePath.replace('.js', options.mode === 'include' ? '_included.js' : '_filtered.js');
                        fs.writeFileSync(outputFile, result.code);
                        console.log('Saved: ' + outputFile + ' (' + result.removedParts.length + ' parts removed)');
                    }
                }
            } else if (choice === '3') {
                if (configNames.length === 0) {
                    console.log('No configurations.');
                } else {
                    for (let index = 0; index < configNames.length; index++) {
                        console.log((index + 1) + '. ' + configNames[index]);
                    }
                    const selection = await this.askQuestion('\nDelete: ');
                    const index = parseInt(selection) - 1;
                    if (index >= 0 && index < configNames.length) {
                        const nameToDelete = configNames[index];
                        delete configurations.configs[nameToDelete];
                        ConfigManager.saveConfigurations(configurations);
                        console.log('Deleted: ' + nameToDelete);
                    }
                }
            }
            
            await this.askQuestion('\nPress Enter...');
        }
    }
}

// ============================================================================
// MAIN CODE PARSER
// ============================================================================
class CodeParser {
    static #sourceCode = '';
    static #filePath = '';

    static analyzeCode(code) {
        this.#sourceCode = code;
        return CodeAnalyzer.analyzeCode(code);
    }

    static createFilteredCode(analysis, options) {
        return CodeFilter.createFilteredCode(this.#sourceCode, analysis, options || {});
    }

    static async runInteractive() {
        const args = process.argv.slice(2);
        
        if (args.length === 0) {
            console.log('Usage: node code-parser-interface.js <file.js> [config-name]');
            process.exit(1);
        }

        this.#filePath = args[0];
        ConfigManager.initializeConfigurationPath(this.#filePath);
        
        if (!fs.existsSync(this.#filePath)) {
            console.error('ERROR: File not found: ' + this.#filePath);
            process.exit(1);
        }

        this.#sourceCode = fs.readFileSync(this.#filePath, 'utf-8');
        const analysis = this.analyzeCode(this.#sourceCode);
        
        if (args.length >= 2) {
            const configurations = ConfigManager.loadConfigurations();
            if (configurations.configs[args[1]]) {
                const options = configurations.configs[args[1]].options;
                console.log('Applying config: ' + args[1]);
                const result = this.createFilteredCode(analysis, options);
                const outputFile = this.#filePath.replace('.js', 
                    options.mode === 'include' ? '_included.js' : '_filtered.js');
                fs.writeFileSync(outputFile, result.code);
                console.log('Saved: ' + outputFile);
                console.log('Removed: ' + result.removedParts.length + ' parts');
                if (result.mergeScriptGenerated) {
                    console.log('Merge script: ' + result.mergeScriptPath);
                }
                process.exit(0);
            }
            console.error('Config not found: ' + args[1]);
            process.exit(1);
        }
        
        const menu = new InteractiveMenu(this.#filePath);
        await menu.displayMainMenu();
    }
}

// ============================================================================
// ENTRY POINT
// ============================================================================
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    CodeParser.runInteractive().catch(console.error);
}

export default CodeParser;