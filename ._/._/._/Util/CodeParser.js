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
    
    // Static methods to break down code into components
    static analyzeCode(code) {
        this.#sourceCode = code;
        return {
            imports: this.extractImports(code),
            exports: this.extractExports(code),
            classes: this.extractClasses(code),
            functions: this.extractFunctions(code),
            variables: this.extractVariables(code),
            comments: this.extractComments(code),
            blocks: this.extractCodeBlocks(code),
            allParts: () => this.getAllParts(code)
        };
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
        
        // Get class ranges to exclude class methods
        const classRanges = this.extractClasses(code).map(cls => ({
            start: cls.start,
            end: cls.end
        }));
        
        const isInsideAnyClass = (pos) => {
            return classRanges.some(range => pos > range.start && pos < range.end);
        };
        
        // Match traditional function declarations
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
        
        // Match arrow function assignments
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
        
        // Match object method assignments (like helperUtil.formatDate)
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

    // Helper methods
    static findMatchingBrace(code, startIndex) {
        let depth = 1;
        let index = startIndex + 1;
        let inString = false;
        let stringChar = '';
        
        while (depth > 0 && index < code.length) {
            const char = code[index];
            
            // Handle strings
            if ((char === '"' || char === "'" || char === '`') && code[index - 1] !== '\\') {
                if (!inString) {
                    inString = true;
                    stringChar = char;
                } else if (char === stringChar) {
                    inString = false;
                }
            }
            
            // Handle template literals
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

    // Method to create filtered code
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
            mode = 'exclude' // 'include' or 'exclude'
        } = options;

        let filteredParts = [];
        
        // Handle imports and exports
        if (includeImports) {
            filteredParts.push(...analysis.imports);
        }
        if (includeExports) {
            filteredParts.push(...analysis.exports);
        }

        // Handle classes
        if (mode === 'include') {
            if (includeClasses.length > 0) {
                filteredParts.push(...analysis.classes.filter(c => includeClasses.includes(c.name)));
            } else {
                filteredParts.push(...analysis.classes);
            }
        } else {
            filteredParts.push(...analysis.classes.filter(c => !excludeClasses.includes(c.name)));
        }

        // Handle functions
        if (mode === 'include') {
            if (includeFunctions.length > 0) {
                filteredParts.push(...analysis.functions.filter(f => includeFunctions.includes(f.name)));
            } else {
                filteredParts.push(...analysis.functions);
            }
        } else {
            filteredParts.push(...analysis.functions.filter(f => !excludeFunctions.includes(f.name)));
        }

        // Handle variables
        if (mode === 'include') {
            if (includeVariables.length > 0) {
                filteredParts.push(...analysis.variables.filter(v => includeVariables.includes(v.name)));
            } else {
                filteredParts.push(...analysis.variables);
            }
        } else {
            filteredParts.push(...analysis.variables.filter(v => !excludeVariables.includes(v.name)));
        }

        // Sort by position and reconstruct
        filteredParts.sort((a, b) => a.start - b.start);
        
        // Build the output maintaining proper spacing
        let output = '';
        filteredParts.forEach((part, index) => {
            if (index > 0) {
                output += '\n\n';
            }
            output += part.content;
        });
        
        return output;
    }

    // Interactive terminal interface
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
            '5': { text: '✂️  Create filtered version (exclude)', action: () => this.filterMenuExclude(analysis, rl) },
            '6': { text: '✅ Create filtered version (include only)', action: () => this.filterMenuInclude(analysis, rl) },
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
            // Show first line preview
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
        console.log('✂️  Create Filtered Version (Exclude Mode)');
        console.log('═'.repeat(50));
        console.log('This will remove the selected parts from the code.\n');
        
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
        
        const options = {
            excludeClasses: excludeClasses ? excludeClasses.split(',').map(s => s.trim()).filter(Boolean) : [],
            excludeFunctions: excludeFunctions ? excludeFunctions.split(',').map(s => s.trim()).filter(Boolean) : [],
            excludeVariables: excludeVariables ? excludeVariables.split(',').map(s => s.trim()).filter(Boolean) : [],
            mode: 'exclude'
        };
        
        const filtered = this.createFilteredCode(analysis, options);
        const outputFile = this.#filePath.replace('.js', '_filtered.js');
        fs.writeFileSync(outputFile, filtered);
        
        console.log('\n' + '═'.repeat(50));
        console.log(`✅ Filtered code saved to: ${outputFile}`);
        console.log(`📊 Original: ${this.#sourceCode.length} chars, ${this.#sourceCode.split('\n').length} lines`);
        console.log(`📊 Filtered: ${filtered.length} chars, ${filtered.split('\n').length} lines`);
        console.log(`📊 Removed: ${this.#sourceCode.length - filtered.length} chars`);
    }

    static async filterMenuInclude(analysis, rl) {
        console.log('✅ Create Filtered Version (Include Only Mode)');
        console.log('═'.repeat(50));
        console.log('This will keep ONLY the selected parts from the code.\n');
        
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
        
        const options = {
            includeClasses: includeClasses ? includeClasses.split(',').map(s => s.trim()).filter(Boolean) : [],
            includeFunctions: includeFunctions ? includeFunctions.split(',').map(s => s.trim()).filter(Boolean) : [],
            includeVariables: includeVariables ? includeVariables.split(',').map(s => s.trim()).filter(Boolean) : [],
            mode: 'include'
        };
        
        const filtered = this.createFilteredCode(analysis, options);
        const outputFile = this.#filePath.replace('.js', '_included.js');
        fs.writeFileSync(outputFile, filtered);
        
        console.log('\n' + '═'.repeat(50));
        console.log(`✅ Included code saved to: ${outputFile}`);
        console.log(`📊 Original: ${this.#sourceCode.length} chars, ${this.#sourceCode.split('\n').length} lines`);
        console.log(`📊 Included: ${filtered.length} chars, ${filtered.split('\n').length} lines`);
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

// Allow running directly or importing as module
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    CodeParser.runInteractive().catch(console.error);
}

export default CodeParser;