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
            
            const whitespaceBefore = code.substring(Math.max(0, part.start - 10), part.start);
            const whitespaceAfter = code.substring(part.end, Math.min(code.length, part.end + 10));
            
            const newlinesBefore = (whitespaceBefore.match(/\n/g) || []).length;
            const newlinesAfter = (whitespaceAfter.match(/\n/g) || []).length;
            
            anchors.push({
                part: part,
                index: index,
                anchorBefore: anchorBefore,
                anchorAfter: anchorAfter,
                originalStart: part.start,
                originalEnd: part.end,
                content: part.content,
                newlinesBefore: newlinesBefore,
                newlinesAfter: newlinesAfter
            });
        });
        
        return anchors;
    }

    static #configFilePath = '';
    
    static getConfigFilePath() {
        if (!this.#configFilePath) {
            this.#configFilePath = path.join(path.dirname(this.#filePath), '.code-parser-configs.json');
        }
        return this.#configFilePath;
    }
    
    static loadConfigurations() {
        const configFile = this.getConfigFilePath();
        if (fs.existsSync(configFile)) {
            try {
                const data = fs.readFileSync(configFile, 'utf-8');
                return JSON.parse(data);
            } catch (error) {
                console.error('⚠️  Error reading configuration file:', error.message);
                return { configs: {} };
            }
        }
        return { configs: {} };
    }
    
    static saveConfigurations(configs) {
        const configFile = this.getConfigFilePath();
        try {
            fs.writeFileSync(configFile, JSON.stringify(configs, null, 2));
            return true;
        } catch (error) {
            console.error('⚠️  Error saving configuration file:', error.message);
            return false;
        }
    }
    
    static saveCurrentConfig(configName, options, analysis) {
        const configs = this.loadConfigurations();
        
        const config = {
            name: configName,
            file: path.basename(this.#filePath),
            created: new Date().toISOString(),
            options: options,
            summary: {
                mode: options.mode,
                excludeClasses: options.excludeClasses || [],
                excludeFunctions: options.excludeFunctions || [],
                excludeVariables: options.excludeVariables || [],
                includeClasses: options.includeClasses || [],
                includeFunctions: options.includeFunctions || [],
                includeVariables: options.includeVariables || [],
                generateMergeScript: options.generateMergeScript || false
            }
        };
        
        configs.configs[configName] = config;
        
        return this.saveConfigurations(configs);
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
            originalEnd: a.originalEnd,
            newlinesBefore: a.newlinesBefore,
            newlinesAfter: a.newlinesAfter
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
 * Get proper spacing to insert before the content
 */
function getInsertPrefix(before, part) {
    if (before.length === 0) return { prefix: '', needsNewlineAfter: false };
    
    const trimmedBefore = before.trimEnd();
    const trailingNewlines = before.length - trimmedBefore.length;
    
    if (trailingNewlines >= 2) {
        return { prefix: '\\n', needsNewlineAfter: true };
    } else if (trailingNewlines === 1) {
        return { prefix: '\\n\\n', needsNewlineAfter: true };
    } else {
        return { prefix: '\\n\\n', needsNewlineAfter: true };
    }
}

/**
 * Find the best insertion point for a removed part
 */
function findInsertionPoint(code, part) {
    const strategies = [
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

function merge(filteredCode) {
    console.log('🔄 Starting merge process...');
    console.log(\`📊 Removed parts to reinsert: \${removedPartsData.length}\`);
    
    let mergedCode = filteredCode;
    let reinsertedCount = 0;
    const warnings = [];
    
    const sortedParts = [...removedPartsData].sort((a, b) => b.originalStart - a.originalStart);
    
    for (const part of sortedParts) {
        const insertionPoint = findInsertionPoint(mergedCode, part);
        
        if (insertionPoint.found) {
            const before = mergedCode.substring(0, insertionPoint.position);
            const after = mergedCode.substring(insertionPoint.position);
            
            const { prefix, needsNewlineAfter } = getInsertPrefix(before, part);
            
            let cleanAfter = after.replace(/^\\n+/, '');
            
            mergedCode = before + prefix + part.content + (needsNewlineAfter ? '\\n' : '') + cleanAfter;
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
    
        // Sort by position descending to remove from end to start (prevents position shifts)
        partsToRemove.sort((a, b) => b.start - a.start);
        
        // Build filtered code by keeping only the parts we want
        let filteredCode = '';
        let lastEnd = 0;
        
        // Sort by position ascending for building
        const sortedParts = [...partsToRemove].sort((a, b) => a.start - b.start);
        
        for (const part of sortedParts) {
            // Keep everything from lastEnd to part.start exactly as-is
            filteredCode += originalCode.substring(lastEnd, part.start);
            lastEnd = part.end;
        }
        
        // Add remaining code after last removed part
        filteredCode += originalCode.substring(lastEnd);
        
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
            console.log('Usage: node code-parser-interface.js <filename.js> [config-name]');
            console.log('       node code-parser-interface.js <filename.js>                 - Interactive mode');
            console.log('       node code-parser-interface.js <filename.js> <config-name>  - Apply saved config directly');
            process.exit(1);
        }

        this.#filePath = args[0];
        
        if (!fs.existsSync(this.#filePath)) {
            console.error(`❌ File not found: ${this.#filePath}`);
            process.exit(1);
        }

        const code = fs.readFileSync(this.#filePath, 'utf-8');
        const analysis = this.analyzeCode(code);
        
        if (args.length >= 2) {
            const configName = args[1];
            const configs = this.loadConfigurations();
            
            if (configs.configs[configName]) {
                console.log('🔧 JavaScript Code Parser - Applying Configuration');
                console.log('═'.repeat(50));
                console.log(`📄 File: ${path.basename(this.#filePath)}`);
                console.log(`⚙️  Config: ${configName}\n`);
                
                const selectedConfig = configs.configs[configName];
                const options = selectedConfig.options;
                
                console.log(`Mode: ${options.mode}`);
                if (options.mode === 'exclude') {
                    if (options.excludeClasses?.length) console.log(`Excluding classes: ${options.excludeClasses.join(', ')}`);
                    if (options.excludeFunctions?.length) console.log(`Excluding functions: ${options.excludeFunctions.join(', ')}`);
                    if (options.excludeVariables?.length) console.log(`Excluding variables: ${options.excludeVariables.join(', ')}`);
                } else {
                    if (options.includeClasses?.length) console.log(`Including classes: ${options.includeClasses.join(', ')}`);
                    if (options.includeFunctions?.length) console.log(`Including functions: ${options.includeFunctions.join(', ')}`);
                    if (options.includeVariables?.length) console.log(`Including variables: ${options.includeVariables.join(', ')}`);
                }
                console.log(`Generate merge script: ${options.generateMergeScript ? 'Yes' : 'No'}`);
                
                const result = this.createFilteredCode(analysis, options);
                
                let outputFile;
                if (options.mode === 'exclude') {
                    outputFile = this.#filePath.replace('.js', '_filtered.js');
                } else {
                    outputFile = this.#filePath.replace('.js', '_included.js');
                }
                
                fs.writeFileSync(outputFile, result.code);
                
                console.log('\n' + '═'.repeat(50));
                console.log(`✅ Filtered code saved to: ${outputFile}`);
                console.log(`📊 Original: ${this.#sourceCode.length} chars, ${this.#sourceCode.split('\n').length} lines`);
                console.log(`📊 Filtered: ${result.code.length} chars, ${result.code.split('\n').length} lines`);
                console.log(`📊 Removed parts: ${result.removedParts.length}`);
                
                if (result.mergeScriptGenerated) {
                    console.log(`\n🔧 Merge script generated: ${result.mergeScriptPath}`);
                    console.log('   Run it later with: node ' + path.basename(result.mergeScriptPath) + ' <updated-filtered-file.js>');
                }
                
                console.log('\n✅ Process completed successfully!');
                process.exit(0);
            } else {
                console.error(`❌ Configuration "${configName}" not found.`);
                console.log('\nAvailable configurations:');
                const configNames = Object.keys(configs.configs);
                if (configNames.length === 0) {
                    console.log('   No configurations saved yet.');
                } else {
                    configNames.forEach(name => console.log(`   • ${name}`));
                }
                process.exit(1);
            }
        }
        
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
            '9': { text: '⚙️  Configuration management', action: () => this.configMenu(analysis, rl) },
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
                if (choice !== '0') {
                    await this.question(rl, '\nPress Enter to continue...');
                    console.clear();
                    showMenu();
                }
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
        
        const saveConfig = await this.question(rl, '\n💾 Save this configuration for future use? (y/n, default: y): ');
        if (saveConfig.toLowerCase() !== 'n') {
            const configName = await this.question(rl, '📝 Configuration name: ');
            if (configName.trim()) {
                const saved = this.saveCurrentConfig(configName.trim(), options, analysis);
                if (saved) {
                    console.log(`✅ Configuration "${configName.trim()}" saved successfully!`);
                    console.log(`   Config file: ${this.getConfigFilePath()}`);
                    console.log(`\n   Usage: node ${path.basename(process.argv[1])} ${path.basename(this.#filePath)} "${configName.trim()}"`);
                } else {
                    console.log('❌ Failed to save configuration.');
                }
            } else {
                console.log('❌ Configuration name cannot be empty. Skipping save.');
            }
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
        
        const saveConfig = await this.question(rl, '\n💾 Save this configuration for future use? (y/n, default: y): ');
        if (saveConfig.toLowerCase() !== 'n') {
            const configName = await this.question(rl, '📝 Configuration name: ');
            if (configName.trim()) {
                const saved = this.saveCurrentConfig(configName.trim(), options, analysis);
                if (saved) {
                    console.log(`✅ Configuration "${configName.trim()}" saved successfully!`);
                    console.log(`   Config file: ${this.getConfigFilePath()}`);
                    console.log(`\n   Usage: node ${path.basename(process.argv[1])} ${path.basename(this.#filePath)} "${configName.trim()}"`);
                } else {
                    console.log('❌ Failed to save configuration.');
                }
            } else {
                console.log('❌ Configuration name cannot be empty. Skipping save.');
            }
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

    static async configMenu(analysis, rl) {
        const configs = this.loadConfigurations();
        const configNames = Object.keys(configs.configs);
        
        const showConfigSubMenu = () => {
            console.log('⚙️  Configuration Management');
            console.log('═'.repeat(50));
            console.log('\n⚙️  Configuration Options:');
            console.log('─'.repeat(50));
            console.log('  1. 📋 List saved configurations');
            console.log('  2. 📂 Load and apply configuration');
            console.log('  3. 🗑️  Delete configuration');
            console.log('  4. 📁 Show config file location');
            console.log('  0. 🔙 Back to main menu');
        };
        
        const handleConfigChoice = async (choice) => {
            switch (choice) {
                case '1':
                    console.log('\n📋 Saved Configurations:');
                    console.log('─'.repeat(50));
                    
                    if (configNames.length === 0) {
                        console.log('   No configurations saved yet.');
                    } else {
                        configNames.forEach((name, index) => {
                            const config = configs.configs[name];
                            console.log(`\n${index + 1}. ${name}`);
                            console.log(`   File: ${config.file}`);
                            console.log(`   Mode: ${config.summary.mode}`);
                            console.log(`   Created: ${config.created}`);
                            if (config.summary.mode === 'exclude') {
                                if (config.summary.excludeClasses.length > 0) 
                                    console.log(`   Excluded classes: ${config.summary.excludeClasses.join(', ')}`);
                                if (config.summary.excludeFunctions.length > 0) 
                                    console.log(`   Excluded functions: ${config.summary.excludeFunctions.join(', ')}`);
                                if (config.summary.excludeVariables.length > 0) 
                                    console.log(`   Excluded variables: ${config.summary.excludeVariables.join(', ')}`);
                            } else {
                                if (config.summary.includeClasses.length > 0) 
                                    console.log(`   Included classes: ${config.summary.includeClasses.join(', ')}`);
                                if (config.summary.includeFunctions.length > 0) 
                                    console.log(`   Included functions: ${config.summary.includeFunctions.join(', ')}`);
                                if (config.summary.includeVariables.length > 0) 
                                    console.log(`   Included variables: ${config.summary.includeVariables.join(', ')}`);
                            }
                            console.log(`   Generate merge: ${config.summary.generateMergeScript ? 'Yes' : 'No'}`);
                            console.log(`   Usage: node ${path.basename(process.argv[1])} ${path.basename(this.#filePath)} "${name}"`);
                        });
                    }
                    return true;
                    
                case '2':
                    if (configNames.length === 0) {
                        console.log('\n❌ No configurations saved. Create one first by running a filter operation.');
                        return true;
                    }
                    
                    console.log('\n📂 Available Configurations:');
                    configNames.forEach((name, index) => {
                        console.log(`  ${index + 1}. ${name}`);
                    });
                    
                    const loadChoice = await this.question(rl, '\nSelect configuration number (or 0 to cancel): ');
                    const configIndex = parseInt(loadChoice) - 1;
                    
                    if (loadChoice === '0') {
                        console.log('❌ Loading cancelled.');
                        return true;
                    }
                    
                    if (isNaN(configIndex) || configIndex < 0 || configIndex >= configNames.length) {
                        console.log('❌ Invalid selection.');
                        return true;
                    }
                    
                    const selectedConfig = configs.configs[configNames[configIndex]];
                    const loadOptions = selectedConfig.options;
                    
                    console.log(`\n✅ Loaded configuration: ${configNames[configIndex]}`);
                    console.log(`   Mode: ${loadOptions.mode}`);
                    
                    const loadResult = this.createFilteredCode(analysis, loadOptions);
                    
                    let outputFile;
                    if (loadOptions.mode === 'exclude') {
                        outputFile = this.#filePath.replace('.js', '_filtered.js');
                    } else {
                        outputFile = this.#filePath.replace('.js', '_included.js');
                    }
                    
                    fs.writeFileSync(outputFile, loadResult.code);
                    
                    console.log(`\n✅ Filtered code saved to: ${outputFile}`);
                    console.log(`📊 Original: ${this.#sourceCode.length} chars`);
                    console.log(`📊 Filtered: ${loadResult.code.length} chars`);
                    console.log(`📊 Removed parts: ${loadResult.removedParts.length}`);
                    
                    if (loadResult.mergeScriptGenerated) {
                        console.log(`\n🔧 Merge script generated: ${loadResult.mergeScriptPath}`);
                    }
                    return true;
                    
                case '3':
                    if (configNames.length === 0) {
                        console.log('\n❌ No configurations saved.');
                        return true;
                    }
                    
                    console.log('\n🗑️  Delete Configuration:');
                    configNames.forEach((name, index) => {
                        console.log(`  ${index + 1}. ${name}`);
                    });
                    
                    const deleteChoice = await this.question(rl, '\nSelect configuration to delete (or 0 to cancel): ');
                    const deleteIndex = parseInt(deleteChoice) - 1;
                    
                    if (deleteChoice === '0') {
                        console.log('❌ Deletion cancelled.');
                        return true;
                    }
                    
                    if (isNaN(deleteIndex) || deleteIndex < 0 || deleteIndex >= configNames.length) {
                        console.log('❌ Invalid selection.');
                        return true;
                    }
                    
                    const nameToDelete = configNames[deleteIndex];
                    const confirm = await this.question(rl, `\n⚠️  Confirm delete "${nameToDelete}"? (y/n): `);
                    
                    if (confirm.toLowerCase() === 'y') {
                        delete configs.configs[nameToDelete];
                        const saved = this.saveConfigurations(configs);
                        if (saved) {
                            console.log(`✅ Configuration "${nameToDelete}" deleted successfully.`);
                        } else {
                            console.log('❌ Failed to delete configuration.');
                        }
                    } else {
                        console.log('❌ Deletion cancelled.');
                    }
                    return true;
                    
                case '4':
                    const configFile = this.getConfigFilePath();
                    console.log(`\n📁 Configuration file: ${configFile}`);
                    if (fs.existsSync(configFile)) {
                        const stats = fs.statSync(configFile);
                        console.log(`   Size: ${stats.size} bytes`);
                        console.log(`   Last modified: ${stats.mtime.toISOString()}`);
                        console.log(`   Configurations: ${configNames.length}`);
                    } else {
                        console.log('   File does not exist yet. Create configurations by saving them after filter operations.');
                    }
                    return true;
                    
                case '0':
                    return false;
                    
                default:
                    console.log('❌ Invalid option. Please try again.');
                    return true;
            }
        };
        
        let running = true;
        while (running) {
            console.clear();
            showConfigSubMenu();
            const choice = await this.question(rl, '\n👉 Select option: ');
            console.clear();
            console.log('⚙️  Configuration Management');
            console.log('═'.repeat(50));
            running = await handleConfigChoice(choice);
            if (running) {
                await this.question(rl, '\nPress Enter to continue...');
            }
        }
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    CodeParser.runInteractive().catch(console.error);
}

export default CodeParser;