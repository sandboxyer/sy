#!/bin/sh

# Lay.sh - Layer directory navigator
# Compatible with sh/ash/bash
# Usage: lay [options]
# Options:
#   [number]        - Move exact number of layers
#   reverse, -r, --reverse  - Force reverse direction
#   back, up, -u, --up     - Go back/up (alternative to reverse)
#   -v, --verbose  - Show detailed output (what's happening)
#   -h, --help     - Show help

LAYER_NAME="._"

# Detect if script is being sourced or executed
is_sourced() {
    # Check if we're being sourced (return works) or executed (return fails)
    case "$0" in
        *lay.sh|*lay|*-lay)
            # Script name matches - might be executed
            # Check if $0 matches the actual script path
            if [ "$0" = "${0#/}" ] && [ -f "./$0" ]; then
                return 1  # Being executed
            elif [ -f "$0" ]; then
                return 1  # Being executed
            else
                return 0  # Being sourced (script is function/alias)
            fi
            ;;
        *)
            return 0  # Being sourced
            ;;
    esac
}

# If executed directly, re-execute with source
if ! is_sourced; then
    # Save current shell if possible
    CURRENT_SHELL="${SHELL:-/bin/sh}"
    
    # For bash
    if echo "$BASH_VERSION" >/dev/null 2>&1; then
        exec bash -c ". \"$0\" $*; exec \$SHELL"
    # For other shells, try sh
    else
        # We can't source from here, so output the command to source
        printf "Please source this script instead:\n"
        printf "  . %s" "$0"
        [ $# -gt 0 ] && printf " %s" "$@"
        printf "\n"
        printf "Or create an alias in your shell config:\n"
        printf "  alias lay='. %s'\n" "$0"
        exit 1
    fi
fi

# Check if terminal supports colors
if [ -t 1 ]; then
    GREEN='\033[0;32m'
    BLUE='\033[0;34m'
    YELLOW='\033[1;33m'
    NC='\033[0m'
else
    GREEN=''
    BLUE=''
    YELLOW=''
    NC=''
fi

show_help() {
    printf "${GREEN}Lay.sh${NC} - Layer Directory Navigator\n"
    printf "====================================\n"
    printf "Navigate between ${BLUE}%s${NC} directory layers like ping-pong.\n\n" "$LAYER_NAME"
    printf "${YELLOW}Usage:${NC}\n"
    printf "  lay                # Go deep to last layer, or back to top (silent)\n"
    printf "  lay [N]            # Move N layers (deep or back) (silent)\n"
    printf "  lay reverse        # Force go back/up (silent)\n"
    printf "  lay back           # Alternative: go back/up (silent)\n"
    printf "  lay -r | --reverse # Same as reverse (silent)\n"
    printf "  lay -u | --up      # Same as back (silent)\n"
    printf "  lay -v | --verbose # Show detailed output\n"
    printf "  lay -h | --help    # Show this help\n"
}

# Parse arguments
REVERSE=0
LAYERS=""
VERBOSE=0

while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help)
            show_help
            return 0 2>/dev/null || exit 0
            ;;
        -v|--verbose)
            VERBOSE=1
            shift
            ;;
        -r|--reverse|reverse|back|-u|--up|up)
            REVERSE=1
            shift
            ;;
        -*)
            printf "Unknown option: %s\n" "$1"
            printf "Use -h for help\n"
            return 1 2>/dev/null || exit 1
            ;;
        *)
            case "$1" in
                ''|*[!0-9]*)
                    printf "Invalid argument: %s (expected number or option)\n" "$1"
                    return 1 2>/dev/null || exit 1
                    ;;
                *)
                    LAYERS="$1"
                    shift
                    ;;
            esac
            ;;
    esac
done

# Store current directory
CURRENT_DIR="$PWD"

# Find deepest ._ path from current position
find_deepest_layer() {
    start_dir="$1"
    current="$start_dir"
    depth=0
    
    while [ -d "$current/$LAYER_NAME" ]; do
        current="$current/$LAYER_NAME"
        depth=$((depth + 1))
    done
    
    printf "%d:%s\n" "$depth" "$current"
}

# Find the top directory above all ._ layers
# This returns the directory that CONTAINS the first ._ layer (not inside any ._ itself)
find_top_directory() {
    current="$1"
    
    # First, go up until we're no longer inside a ._ directory
    while [ "$current" != "/" ] && [ "$(basename "$current")" = "$LAYER_NAME" ]; do
        current="$(dirname "$current")"
    done
    
    # Now go up until we find a directory that has a ._ subdirectory
    while [ "$current" != "/" ]; do
        if [ -d "$current/$LAYER_NAME" ]; then
            break
        fi
        current="$(dirname "$current")"
    done
    
    printf "%s\n" "$current"
}

# Count how many ._ layers are above current position
count_layers_above() {
    current="$1"
    count=0
    
    while [ "$current" != "/" ]; do
        if [ "$(basename "$current")" = "$LAYER_NAME" ]; then
            count=$((count + 1))
        fi
        current="$(dirname "$current")"
    done
    
    printf "%d\n" "$count"
}

# Go deep into layers
go_deep() {
    deep_info=$(find_deepest_layer "$CURRENT_DIR")
    available_layers=$(printf "%s" "$deep_info" | cut -d: -f1)
    deepest_path=$(printf "%s" "$deep_info" | cut -d: -f2)
    
    if [ "$available_layers" -eq 0 ]; then
        [ $VERBOSE -eq 1 ] && printf "Already at the deepest level (no %s directories found)\n" "$LAYER_NAME"
        return 1
    fi
    
    target_path="$deepest_path"
    
    if [ -n "$LAYERS" ]; then
        if [ "$LAYERS" -gt "$available_layers" ]; then
            [ $VERBOSE -eq 1 ] && printf "${YELLOW}Requested %d layers, but only %d available${NC}\n" "$LAYERS" "$available_layers"
            target_path="$deepest_path"
        else
            current="$CURRENT_DIR"
            i=0
            while [ $i -lt "$LAYERS" ]; do
                if [ -d "$current/$LAYER_NAME" ]; then
                    current="$current/$LAYER_NAME"
                    i=$((i + 1))
                else
                    break
                fi
            done
            target_path="$current"
            [ $VERBOSE -eq 1 ] && printf "Moving %d layer(s) deeper...\n" "$LAYERS"
        fi
    else
        [ $VERBOSE -eq 1 ] && printf "Moving to deepest layer (%d level(s) deep)...\n" "$available_layers"
    fi
    
    if [ "$target_path" != "$CURRENT_DIR" ]; then
        cd "$target_path" || return 1
        [ $VERBOSE -eq 1 ] && printf "Now at: %s\n" "$PWD"
        return 0
    else
        [ $VERBOSE -eq 1 ] && printf "Already at target directory\n"
        return 1
    fi
}

# Go back from layers
go_back() {
    layers_above=$(count_layers_above "$CURRENT_DIR")
    
    if [ -n "$LAYERS" ]; then
        if [ "$LAYERS" -gt "$layers_above" ]; then
            [ $VERBOSE -eq 1 ] && printf "${YELLOW}Requested to go back %d layers, but only %d available${NC}\n" "$LAYERS" "$layers_above"
            target_path=$(find_top_directory "$CURRENT_DIR")
        else
            current="$CURRENT_DIR"
            i=0
            # Go up the specified number of layers, but stop at ._ boundaries
            while [ $i -lt "$LAYERS" ]; do
                # If we're in a ._ directory, go to its parent
                if [ "$(basename "$current")" = "$LAYER_NAME" ]; then
                    current="$(dirname "$current")"
                    i=$((i + 1))
                else
                    # We're above all ._ layers
                    break
                fi
            done
            target_path="$current"
            [ $VERBOSE -eq 1 ] && printf "Moving back %d layer(s)...\n" "$LAYERS"
        fi
    else
        # Go back to the top directory (the one containing the first ._ layer)
        target_path=$(find_top_directory "$CURRENT_DIR")
        [ $VERBOSE -eq 1 ] && printf "Moving back to top directory...\n"
    fi
    
    if [ "$target_path" != "$CURRENT_DIR" ]; then
        cd "$target_path" || return 1
        [ $VERBOSE -eq 1 ] && printf "Now at: %s\n" "$PWD"
        return 0
    else
        [ $VERBOSE -eq 1 ] && printf "Already at the top level\n"
        return 1
    fi
}

# Main logic
layers_above=$(count_layers_above "$CURRENT_DIR")
deep_info=$(find_deepest_layer "$CURRENT_DIR")
available_deep=$(printf "%s" "$deep_info" | cut -d: -f1)

if [ $REVERSE -eq 1 ]; then
    if [ $layers_above -eq 0 ]; then
        [ $VERBOSE -eq 1 ] && printf "Not inside any %s directory\n" "$LAYER_NAME"
        [ $VERBOSE -eq 0 ] && clear
        return 1 2>/dev/null || exit 1
    fi
    go_back
    [ $? -eq 0 ] && [ $VERBOSE -eq 0 ] && clear
elif [ $layers_above -gt 0 ]; then
    go_back
    [ $? -eq 0 ] && [ $VERBOSE -eq 0 ] && clear
elif [ $available_deep -gt 0 ]; then
    go_deep
    [ $? -eq 0 ] && [ $VERBOSE -eq 0 ] && clear
else
    [ $VERBOSE -eq 1 ] && printf "No %s directories found in current path\n" "$LAYER_NAME"
    [ $VERBOSE -eq 1 ] && printf "Current directory: %s\n" "$PWD"
    [ $VERBOSE -eq 0 ] && clear
    return 1 2>/dev/null || exit 1
fi