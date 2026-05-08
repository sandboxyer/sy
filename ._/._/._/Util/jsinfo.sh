#!/bin/sh

# Node.js Interface Analyzer - Pure Shell Script Version
# Compatible with ash, dash, bash

set -e

# Global variables
BASE_DIR="/tmp/jsinfo"
TIMESTAMP=$(date +%Y-%m-%dT%H-%M-%S-000Z)
TARGET_DIR="$BASE_DIR/$TIMESTAMP"
GENERATE_SH=0
PATHS=""
SCRIPT_NAME=""

# Native Node.js modules set (simulated with case statements)
is_native_module() {
    module="$1"
    # Remove node: prefix if present
    module="${module#node:}"
    
    case "$module" in
        assert|async_hooks|buffer|child_process|cluster|\
        console|constants|crypto|dgram|diagnostics_channel|\
        dns|domain|events|fs|http|http2|https|\
        inspector|module|net|os|path|perf_hooks|\
        process|punycode|querystring|readline|repl|\
        stream|string_decoder|timers|tls|trace_events|\
        tty|url|util|v8|vm|wasi|worker_threads|\
        zlib|fs/promises|timers/promises|stream/promises|\
        stream/consumers|stream/web|dns/promises|readline/promises)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

# Count native module imports in a file
count_native_imports() {
    file="$1"
    tmp_output="$2"
    
    > "$tmp_output"
    
    # Process import default from 'module'
    grep -oE "import [a-zA-Z_][a-zA-Z0-9_]* from ['\"][^'\"]+['\"]" "$file" | while read -r line; do
        import_name=$(echo "$line" | sed -E "s/import ([a-zA-Z_][a-zA-Z0-9_]*) from ['\"]([^'\"]+)['\"]/\1/")
        module_name=$(echo "$line" | sed -E "s/import ([a-zA-Z_][a-zA-Z0-9_]*) from ['\"]([^'\"]+)['\"]/\2/")
        
        if is_native_module "$module_name"; then
            clean_module=$(echo "$module_name" | sed 's/^node://')
            echo "IMPORT|${clean_module}|import ${import_name}" >> "$tmp_output"
        fi
    done
    
    # Process import { named } from 'module'
    grep -oE "import \{[^}]+\} from ['\"][^'\"]+['\"]" "$file" | while read -r line; do
        bindings=$(echo "$line" | sed -E 's/import \{([^}]+)\} from ['"'"'"]([^'"'"'"]+)['"'"'"]/\1/')
        module_name=$(echo "$line" | sed -E 's/import \{([^}]+)\} from ['"'"'"]([^'"'"'"]+)['"'"'"]/\2/')
        
        if is_native_module "$module_name"; then
            clean_module=$(echo "$module_name" | sed 's/^node://')
            echo "IMPORT|${clean_module}|import { ${bindings} }" >> "$tmp_output"
        fi
    done
    
    # Process import * as name from 'module'
    grep -oE "import \* as [a-zA-Z_][a-zA-Z0-9_]* from ['\"][^'\"]+['\"]" "$file" | while read -r line; do
        import_name=$(echo "$line" | sed -E "s/import \* as ([a-zA-Z_][a-zA-Z0-9_]*) from ['\"]([^'\"]+)['\"]/\1/")
        module_name=$(echo "$line" | sed -E "s/import \* as ([a-zA-Z_][a-zA-Z0-9_]*) from ['\"]([^'\"]+)['\"]/\2/")
        
        if is_native_module "$module_name"; then
            clean_module=$(echo "$module_name" | sed 's/^node://')
            echo "IMPORT|${clean_module}|import * as ${import_name}" >> "$tmp_output"
        fi
    done
    
    # Process import 'module' (side effect)
    grep -oE "import ['\"][^'\"]+['\"]" "$file" | grep -v "from" | while read -r line; do
        module_name=$(echo "$line" | sed -E "s/import ['\"]([^'\"]+)['\"]/\1/")
        
        if is_native_module "$module_name"; then
            clean_module=$(echo "$module_name" | sed 's/^node://')
            echo "IMPORT|${clean_module}|import (side effect)" >> "$tmp_output"
        fi
    done
    
    # Process dynamic import()
    grep -oE "import\(['\"][^'\"]+['\"]\)" "$file" | while read -r line; do
        module_name=$(echo "$line" | sed -E "s/import\(['\"]([^'\"]+)['\"]\)/\1/")
        
        if is_native_module "$module_name"; then
            clean_module=$(echo "$module_name" | sed 's/^node://')
            echo "IMPORT|${clean_module}|import() (dynamic)" >> "$tmp_output"
        fi
    done
}

# Extract interfaces and methods
extract_interfaces() {
    file="$1"
    tmp_output="$2"
    
    > "$tmp_output"
    
    # First, extract import bindings
    tmp_bindings="/tmp/jsinfo_bindings_$$"
    > "$tmp_bindings"
    
    # Extract default imports
    grep -oE "import [a-zA-Z_][a-zA-Z0-9_]* from ['\"][^'\"]+['\"]" "$file" | while read -r line; do
        import_name=$(echo "$line" | sed -E "s/import ([a-zA-Z_][a-zA-Z0-9_]*) from ['\"]([^'\"]+)['\"]/\1/")
        module_name=$(echo "$line" | sed -E "s/import ([a-zA-Z_][a-zA-Z0-9_]*) from ['\"]([^'\"]+)['\"]/\2/" | sed 's/^node://')
        echo "BINDING|${import_name}|${module_name}" >> "$tmp_bindings"
    done
    
    # Extract namespace imports
    grep -oE "import \* as [a-zA-Z_][a-zA-Z0-9_]* from ['\"][^'\"]+['\"]" "$file" | while read -r line; do
        import_name=$(echo "$line" | sed -E "s/import \* as ([a-zA-Z_][a-zA-Z0-9_]*) from ['\"]([^'\"]+)['\"]/\1/")
        module_name=$(echo "$line" | sed -E "s/import \* as ([a-zA-Z_][a-zA-Z0-9_]*) from ['\"]([^'\"]+)['\"]/\2/" | sed 's/^node://')
        echo "BINDING|${import_name}|${module_name}" >> "$tmp_bindings"
    done
    
    # Extract named imports
    grep -oE "import \{[^}]+\} from ['\"][^'\"]+['\"]" "$file" | while read -r line; do
        bindings=$(echo "$line" | sed -E 's/import \{([^}]+)\} from ['"'"'"]([^'"'"'"]+)['"'"'"]/\1/')
        module_name=$(echo "$line" | sed -E 's/import \{([^}]+)\} from ['"'"'"]([^'"'"'"]+)['"'"'"]/\2/' | sed 's/^node://')
        
        # Split bindings and process each
        echo "$bindings" | tr ',' '\n' | while read -r binding; do
            binding=$(echo "$binding" | sed -E 's/.* as ([a-zA-Z_][a-zA-Z0-9_]*).*/\1/;t; s/^[[:space:]]*([a-zA-Z_][a-zA-Z0-9_]*)[[:space:]]*$/\1/')
            echo "BINDING|${binding}|${module_name}" >> "$tmp_bindings"
        done
    done
    
    # Find method calls on imported objects: obj.method()
    grep -oE '[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*\s*\(' "$file" | while read -r line; do
        object_name=$(echo "$line" | sed -E 's/([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/\1/')
        method_name=$(echo "$line" | sed -E 's/([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/\2/')
        
        module=$(grep "^BINDING|${object_name}|" "$tmp_bindings" 2>/dev/null | head -1 | cut -d'|' -f3)
        if [ -n "$module" ]; then
            echo "INTERFACE|${module}|${method_name}" >> "$tmp_output"
        fi
    done
    
    # Find property access on imported objects
    grep -oE '[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*' "$file" | grep -v '\.prototype' | while read -r line; do
        object_name=$(echo "$line" | sed -E 's/([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)/\1/')
        prop_name=$(echo "$line" | sed -E 's/([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)/\2/')
        
        module=$(grep "^BINDING|${object_name}|" "$tmp_bindings" 2>/dev/null | head -1 | cut -d'|' -f3)
        if [ -n "$module" ]; then
            echo "INTERFACE|${module}|${prop_name}" >> "$tmp_output"
        fi
    done
    
    rm -f "$tmp_bindings"
}

# Get unique variations per module
get_unique_variations() {
    input_file="$1"
    sort -u "$input_file" | awk -F'|' '
    {
        module = $2
        variation = $3
        if (!(module in variations)) {
            variations[module] = ""
        }
        if (variations[module] !~ variation) {
            if (variations[module] == "") {
                variations[module] = variation
            } else {
                variations[module] = variations[module] "|" variation
            }
        }
    }
    END {
        for (module in variations) {
            print module ":" variations[module]
        }
    }'
}

# Get unique interfaces per module
get_unique_interfaces() {
    input_file="$1"
    sort -u "$input_file" | awk -F'|' '
    {
        module = $2
        method = $3
        if (!(module in methods)) {
            methods[module] = ""
        }
        if (methods[module] !~ method) {
            if (methods[module] == "") {
                methods[module] = method
            } else {
                methods[module] = methods[module] "," method
            }
        }
    }
    END {
        for (module in methods) {
            print module ":" methods[module]
        }
    }'
}

# Print results to console
print_results() {
    import_file="$1"
    interface_file="$2"
    
    if [ ! -s "$import_file" ]; then
        echo "   No native Node.js module imports found."
        return
    fi
    
    # Get unique variations
    variations=$(get_unique_variations "$import_file")
    total_unique=0
    
    echo "$variations" | while IFS=':' read -r module vars; do
        if [ -n "$module" ]; then
            # Count unique variations
            count=$(echo "$vars" | tr '|' '\n' | wc -l)
            total_unique=$((total_unique + count))
            
            echo "   📦 ${module}:"
            echo "      Unique variations: ${count}"
            echo "      Variations:"
            echo "$vars" | tr '|' '\n' | while read -r var; do
                echo "        • ${var}"
            done
            
            # Show interfaces for this module
            if [ -s "$interface_file" ]; then
                methods=$(grep "^INTERFACE|${module}|" "$interface_file" | cut -d'|' -f3 | sort -u)
                if [ -n "$methods" ]; then
                    method_count=$(echo "$methods" | wc -l)
                    echo "      Methods/Interfaces (${method_count}):"
                    echo "$methods" | while read -r method; do
                        echo "        - ${method}"
                    done
                fi
            fi
        fi
    done
}

# Generate shell script
generate_shell_script() {
    output_script="generate-jsinfo-${TIMESTAMP}.sh"
    tmp_combined_imports="/tmp/jsinfo_combined_imports_$$"
    tmp_combined_interfaces="/tmp/jsinfo_combined_interfaces_$$"
    
    > "$tmp_combined_imports"
    > "$tmp_combined_interfaces"
    
    # Combine all results
    for result_dir in /tmp/jsinfo_results_$$_*; do
        if [ -f "${result_dir}/imports" ]; then
            cat "${result_dir}/imports" >> "$tmp_combined_imports"
        fi
        if [ -f "${result_dir}/interfaces" ]; then
            cat "${result_dir}/interfaces" >> "$tmp_combined_interfaces"
        fi
    done
    
    # Create script header
    cat > "$output_script" << EOF
#!/bin/sh
# Generated by Node.js Interface Analyzer
# Generated at: $(date -u +%Y-%m-%dT%H:%M:%S.%NZ)
# This script creates a directory structure in /tmp/jsinfo/

BASE_DIR="/tmp/jsinfo"
TIMESTAMP="${TIMESTAMP}"
TARGET_DIR="\$BASE_DIR/\$TIMESTAMP"

echo "Creating interface directory structure in \$TARGET_DIR..."
mkdir -p "\$TARGET_DIR"

EOF
    
    # Process unique variations and interfaces
    get_unique_variations "$tmp_combined_imports" > "/tmp/jsinfo_vars_$$" &
    get_unique_interfaces "$tmp_combined_interfaces" > "/tmp/jsinfo_interfaces_$$" &
    wait
    
    # Generate directory creation and README for each module
    cat "/tmp/jsinfo_vars_$$" | while IFS=':' read -r module variations; do
        if [ -n "$module" ]; then
            safe_module=$(echo "$module" | tr '/' '_')
            module_dir="\$TARGET_DIR/${safe_module}"
            
            cat >> "$output_script" << EOF
echo "Creating structure for module: ${module}"
mkdir -p "${module_dir}"

EOF
            
            # Create README for module
            cat >> "$output_script" << EOF
cat > "${module_dir}/README.md" << 'MODULE_EOF'
# Module: ${module}

## Import Variations
EOF
            
            # Add variations to README
            echo "$variations" | tr '|' '\n' | sort -u | while read -r var; do
                echo "- \`${var}\`" >> "$output_script"
            done
            
            cat >> "$output_script" << EOF

## Interfaces & Methods

\`\`\`
EOF
            
            # Get interfaces for this module
            interfaces=$(grep "^${module}:" "/tmp/jsinfo_interfaces_$$" 2>/dev/null | cut -d':' -f2 | tr ',' '\n' | sort -u)
            if [ -n "$interfaces" ]; then
                echo "$interfaces" | while read -r method; do
                    # Create method file
                    safe_method=$(echo "$method" | sed 's/[^a-zA-Z0-9_]/_/g')
                    echo "echo \"# Method: ${method}\" > \"${module_dir}/${safe_method}.method\"" >> "$output_script"
                    echo "${method}()" >> "$output_script"
                done
            fi
            
            cat >> "$output_script" << EOF
\`\`\`
MODULE_EOF

EOF
        fi
    done
    
    # Create root README
    cat >> "$output_script" << EOF
# Create root README
cat > "\$TARGET_DIR/README.md" << 'ROOT_EOF'
# Node.js Interface Analysis

Generated at: \$(date)
Total files analyzed: ${TOTAL_FILES}

## Module Structure

\`\`\`
EOF
    
    # Add module directories to root README
    cat "/tmp/jsinfo_vars_$$" | while IFS=':' read -r module variations; do
        if [ -n "$module" ]; then
            safe_module=$(echo "$module" | tr '/' '_')
            echo "${safe_module}/" >> "$output_script"
        fi
    done
    
    cat >> "$output_script" << EOF
\`\`\`
ROOT_EOF

echo ""
echo "✅ Directory structure created successfully!"
echo "📍 Location: \$TARGET_DIR"
echo ""
echo "Modules analyzed:"
EOF
    
    # Add module summary
    cat "/tmp/jsinfo_vars_$$" | while IFS=':' read -r module variations; do
        if [ -n "$module" ]; then
            count=$(echo "$variations" | tr '|' '\n' | wc -l)
            echo "echo \"  📦 ${module}: ${count} methods/interfaces\"" >> "$output_script"
        fi
    done
    
    cat >> "$output_script" << EOF
echo ""
echo "To explore: cd \$TARGET_DIR && find . -type f | sort"
EOF
    
    # Make script executable
    chmod 755 "$output_script"
    
    # Cleanup
    rm -f "$tmp_combined_imports" "$tmp_combined_interfaces" /tmp/jsinfo_vars_$$ /tmp/jsinfo_interfaces_$$
    
    echo "$output_script"
}

# Get all .js files from path
get_js_files() {
    input_path="$1"
    
    if [ ! -e "$input_path" ]; then
        echo "Path not found: $input_path" >&2
        return
    fi
    
    if [ -f "$input_path" ]; then
        case "$input_path" in
            *.js) echo "$input_path" ;;
        esac
    elif [ -d "$input_path" ]; then
        find "$input_path" -type f -name "*.js"
    fi
}

# Main execution
main() {
    TOTAL_FILES=0
    
    # Parse arguments
    for arg in "$@"; do
        case "$arg" in
            --sh)
                GENERATE_SH=1
                ;;
            *)
                if [ -z "$PATHS" ]; then
                    PATHS="$arg"
                else
                    PATHS="$PATHS $arg"
                fi
                ;;
        esac
    done
    
    if [ -z "$PATHS" ]; then
        echo "❌ Please provide at least one .js file or directory"
        echo "Usage: $0 [--sh] <file1.js> <file2.js> <dir1> ..."
        echo "  --sh    Generate shell script that creates interface structure in /tmp/jsinfo/"
        exit 1
    fi
    
    # Collect all JS files
    ALL_FILES=""
    for path in $PATHS; do
        files=$(get_js_files "$path")
        if [ -n "$files" ]; then
            if [ -z "$ALL_FILES" ]; then
                ALL_FILES="$files"
            else
                ALL_FILES="$ALL_FILES
$files"
            fi
        fi
    done
    
    if [ -z "$ALL_FILES" ]; then
        echo "❌ No .js files found"
        exit 1
    fi
    
    # Count files and display
    TOTAL_FILES=$(echo "$ALL_FILES" | wc -l)
    echo "📁 Found ${TOTAL_FILES} JavaScript file(s):"
    echo "$ALL_FILES" | while read -r file; do
        echo "   - ${file}"
    done
    echo ""
    
    # Create temp directory for results
    RESULTS_DIR="/tmp/jsinfo_results_$$_0"
    mkdir -p "$RESULTS_DIR"
    
    # Analyze each file
    file_index=0
    echo "$ALL_FILES" | while read -r file; do
        if [ -n "$file" ]; then
            RESULT_DIR="/tmp/jsinfo_results_$$_${file_index}"
            mkdir -p "$RESULT_DIR"
            
            echo "📄 Analyzing: $(basename "$file")"
            
            # Count imports
            count_native_imports "$file" "${RESULT_DIR}/imports"
            
            # Extract interfaces
            extract_interfaces "$file" "${RESULT_DIR}/interfaces"
            
            # Print results
            print_results "${RESULT_DIR}/imports" "${RESULT_DIR}/interfaces"
            echo ""
            
            file_index=$((file_index + 1))
        fi
    done
    
    wait
    
    # Generate shell script if --sh flag is present
    if [ "$GENERATE_SH" = "1" ]; then
        echo "🔨 Generating shell script..."
        SCRIPT_NAME=$(generate_shell_script)
        echo "✅ Shell script generated: $SCRIPT_NAME"
        echo ""
        echo "📝 To create the interface structure, run:"
        echo "   ./$SCRIPT_NAME"
        echo ""
        echo "📍 This will create: /tmp/jsinfo/[timestamp]/"
    fi
    
    # Cleanup temp files
    rm -rf /tmp/jsinfo_results_$$_*
}

# Run main function
main "$@"