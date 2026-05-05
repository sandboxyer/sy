#!/bin/sh

# ============================================================================
# QEMU VM Launcher - Unified Script for Multiple OS
# ============================================================================
# Usage:
#   bash qemu.sh                              # Alpine, temporary mode (default)
#   bash qemu.sh myvm                         # Alpine, persistent mode
#   bash qemu.sh --ubuntu                     # Ubuntu, temporary mode
#   bash qemu.sh --ubuntu myvm                # Ubuntu, persistent mode
#   bash qemu.sh myvm --size 10G --port 2222  # Alpine, persistent, custom settings
#   bash qemu.sh --ubuntu --size 15G          # Ubuntu, temporary, 15G disk
#   bash qemu.sh --cpu 2                      # Alpine, temporary, 2 CPU cores
#   bash qemu.sh --ubuntu --cpu 4 --memory 4096 # Ubuntu, 4 cores, 4GB RAM
# ============================================================================

# --- Default Configuration ---
DEFAULT_OS="alpine"
SSH_BASE_PORT=2222
DEFAULT_DISK_SIZE="10G"
DEFAULT_MEMORY="2048"  # Will be auto-adjusted based on host RAM and OS
ALPINE_DEFAULT_MEMORY="256"  # Alpine runs well with minimal memory
MAX_RETRY_ATTEMPTS=18  # Maximum retry attempts for port conflicts
RETRY_DELAY_SECONDS=3  # Delay between retries (will try for ~2.5 minutes with these settings)
DEFAULT_CPU_CORES=1    # Default number of CPU cores

# --- Helper: Show help message ---
show_help() {
    cat << 'HELPEOF'
QEMU VM Launcher - Multiple OS Quick Start
===========================================

USAGE: bash qemu.sh [OS] [NAME] [OPTIONS]

OS:
  --alpine            Alpine Linux 3.23 (default)
  --ubuntu            Ubuntu Server 24.04

NAME:
  myvm                Persistent VM (omit for temporary/auto-destroy)

OPTIONS:
  --port N            SSH port (default: 2222, auto-finds free)
  --size SIZE         Disk size (default: 5G, ex: 10G, 20G)
  --memory MB         RAM in MB (auto-calculated if omitted)
  --cpu N             Number of CPU cores (default: 1, auto-capped to host max)
  --no-kvm            Disable KVM acceleration
  --retry-attempts N  Max retry attempts on port conflict (default: ${MAX_RETRY_ATTEMPTS})
  --retry-delay N     Delay between retries in seconds (default: ${RETRY_DELAY_SECONDS})
  -h, --help          Show this help

EXAMPLES:
  bash qemu.sh                           # Alpine, temp, auto-destroy
  bash qemu.sh dev                       # Alpine, persistent as "dev"
  bash qemu.sh --ubuntu                  # Ubuntu, temp
  bash qemu.sh --ubuntu web --size 10G   # Ubuntu, persistent, 10G disk
  bash qemu.sh --port 2222 --memory 4096 # Custom port & memory
  bash qemu.sh --cpu 2                   # Alpine with 2 CPU cores
  bash qemu.sh --ubuntu --cpu 4 --memory 4096 # Ubuntu, 4 cores, 4GB RAM
  bash qemu.sh --no-kvm                  # Force software emulation
  bash qemu.sh --retry-attempts 20       # More retries for busy environments

ACCESS:  ssh root@localhost -p PORT  (password: 123)

HELPEOF
    exit 0
}

# --- OS Definitions (Add new OS here following this pattern) ---
# Format:
#   OS_NAME|img_url|img_filename|iso_filename|default_password|hostname_prefix
# 
# Available OS definitions:
#   alpine  - Alpine Linux 3.23.4 (cloud-init, BIOS)
#   ubuntu  - Ubuntu Server 24.04 Noble (cloud-init)
#   debian  - Debian 12 Bookworm (cloud-init) [EXAMPLE - adjust URL as needed]
#   fedora  - Fedora 40 Cloud (cloud-init) [EXAMPLE - adjust URL as needed]
#
# To add a new OS, just add a new case in get_os_config() function below

get_os_config() {
    local os="$1"
    case "$os" in
        alpine)
            IMG_URL="https://dl-cdn.alpinelinux.org/alpine/v3.23/releases/cloud/generic_alpine-3.23.4-x86_64-bios-cloudinit-r0.qcow2"
            IMG_FILE="alpine-cloudinit.qcow2"
            ISO_FILE="alpine-cloud-init.iso"
            DEFAULT_PASSWORD="123"
            HOSTNAME_PREFIX="alpine"
            CLOUD_USER="root"  # Alpine uses root by default for cloud-init
            ;;
        ubuntu)
            IMG_URL="https://cloud-images.ubuntu.com/noble/20260216/noble-server-cloudimg-amd64.img"
            IMG_FILE="noble-server-cloudimg-amd64.img"
            ISO_FILE="noble-cloud-init.iso"
            DEFAULT_PASSWORD="123"
            HOSTNAME_PREFIX="noble"
            CLOUD_USER="root"
            ;;
        # Example: Add more OS definitions here
        # debian)
        #     IMG_URL="https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2"
        #     IMG_FILE="debian-cloudimg.qcow2"
        #     ISO_FILE="debian-cloud-init.iso"
        #     DEFAULT_PASSWORD="123"
        #     HOSTNAME_PREFIX="debian"
        #     CLOUD_USER="root"
        #     ;;
        *)
            echo "ERROR: Unknown OS type: $os"
            echo "Supported OS: alpine, ubuntu"
            exit 1
            ;;
    esac
}

# --- Helper: Get host CPU core count ---
get_host_cpu_cores() {
    # Try multiple methods to get the number of CPU cores
    if command -v nproc >/dev/null 2>&1; then
        nproc --all
    elif [ -f /proc/cpuinfo ]; then
        grep -c "^processor" /proc/cpuinfo
    elif command -v sysctl >/dev/null 2>&1; then
        # macOS
        sysctl -n hw.ncpu 2>/dev/null || echo "1"
    else
        # Safe fallback
        echo "1"
    fi
}

# --- Helper: Validate and cap CPU cores ---
validate_cpu_cores() {
    local requested_cores="$1"
    local host_cores=$(get_host_cpu_cores)
    
    # Validate input is a positive integer
    if ! [ "$requested_cores" -eq "$requested_cores" ] 2>/dev/null || [ "$requested_cores" -lt 1 ]; then
        echo "ERROR: Invalid CPU core count: $requested_cores (must be positive integer)" >&2
        exit 1
    fi
    
    # Cap to host maximum
    if [ "$requested_cores" -gt "$host_cores" ]; then
        echo "[CPU] Requested ${requested_cores} cores exceeds host maximum (${host_cores})" >&2
        echo "[CPU] Falling back to host maximum: ${host_cores} cores" >&2
        echo "$host_cores"
    else
        echo "[CPU] Using ${requested_cores} CPU core(s) (host has ${host_cores})" >&2
        echo "$requested_cores"
    fi
}

# --- Helper: Get total system memory in MB ---
get_total_memory_mb() {
    if [ -f /proc/meminfo ]; then
        awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null
    elif command -v sysctl >/dev/null 2>&1; then
        # macOS
        sysctl -n hw.memsize 2>/dev/null | awk '{print int($1/1024/1024)}'
    else
        echo "0"
    fi
}

# --- Helper: Get available system memory in MB ---
get_available_memory_mb() {
    # Try multiple methods to get available memory
    if [ -f /proc/meminfo ]; then
        # Linux: Get MemAvailable (preferred) or fallback to MemFree + Buffers + Cached
        local mem_available=$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null)
        if [ -n "$mem_available" ] && [ "$mem_available" -gt 0 ]; then
            echo "$mem_available"
            return 0
        fi
        # Fallback calculation
        local mem_free=$(awk '/^MemFree:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null)
        local buffers=$(awk '/^Buffers:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null)
        local cached=$(awk '/^Cached:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null)
        echo $((mem_free + buffers + cached))
    elif command -v vm_stat >/dev/null 2>&1; then
        # macOS
        local page_size=$(vm_stat | awk '/page size/ {print $8}')
        local free_pages=$(vm_stat | awk '/Pages free/ {print $3}' | tr -d '.')
        echo $((free_pages * page_size / 1024 / 1024))
    else
        # Last resort: assume 4096 MB available
        echo "4096"
    fi
}

# --- Helper: Calculate safe VM memory size ---
calculate_vm_memory() {
    local requested_memory="$1"
    local os_type="$2"
    local available_mem=$(get_available_memory_mb)
    local total_mem=$(get_total_memory_mb)
    
    echo "[MEMORY] Host total memory: ${total_mem}MB, available: ${available_mem}MB" >&2
    
    # If specific memory requested, honor it exactly (only validate against total system memory)
    if [ -n "$requested_memory" ] && [ "$requested_memory" -gt 0 ]; then
        # Only check against total system memory
        if [ "$total_mem" -gt 0 ] && [ "$requested_memory" -gt "$total_mem" ]; then
            echo "ERROR: Requested memory (${requested_memory}MB) exceeds total system memory (${total_mem}MB)" >&2
            exit 1
        fi
        
        # Warn if requested exceeds currently available (but still allow it)
        if [ "$requested_memory" -gt "$available_mem" ]; then
            echo "[WARNING] Requested memory (${requested_memory}MB) exceeds currently available memory (${available_mem}MB)" >&2
            echo "[WARNING] VM may use swap or fail if memory cannot be allocated" >&2
        fi
        
        echo "[MEMORY] Using requested memory: ${requested_memory}MB" >&2
        echo "$requested_memory"
        return 0
    fi
    
    # Auto-calculate based on available memory and OS type (only when no custom memory specified)
    local vm_memory
    
    # For Alpine, we can be much more conservative
    if [ "$os_type" = "alpine" ]; then
        if [ "$available_mem" -ge 8192 ]; then
            vm_memory="$ALPINE_DEFAULT_MEMORY"  # Alpine runs fine on 256MB even with plenty of RAM
            echo "[MEMORY] Alpine selected, using minimal memory: ${vm_memory}MB" >&2
        elif [ "$available_mem" -ge 2048 ]; then
            vm_memory="$ALPINE_DEFAULT_MEMORY"  # 256MB is enough for Alpine
            echo "[MEMORY] Alpine selected, using minimal memory: ${vm_memory}MB" >&2
        elif [ "$available_mem" -ge 1024 ]; then
            vm_memory="$ALPINE_DEFAULT_MEMORY"  # 256MB still possible
            echo "[MEMORY] Alpine selected, using minimal memory: ${vm_memory}MB" >&2
        elif [ "$available_mem" -ge 512 ]; then
            vm_memory=256   # 256MB minimum for Alpine
            echo "[MEMORY] Low memory, Alpine using minimum: ${vm_memory}MB" >&2
        elif [ "$available_mem" -ge 384 ]; then
            vm_memory=192   # Alpine can run on very little
            echo "[MEMORY] Very low memory! Alpine using absolute minimum: ${vm_memory}MB" >&2
            echo "[WARNING] VM may be unstable with only ${vm_memory}MB RAM" >&2
        elif [ "$available_mem" -ge 256 ]; then
            vm_memory=128   # Alpine absolute minimum
            echo "[MEMORY] Extremely low memory! Alpine using bare minimum: ${vm_memory}MB" >&2
            echo "[WARNING] VM will be severely limited with only ${vm_memory}MB RAM" >&2
        else
            echo "ERROR: Insufficient memory available (${available_mem}MB). Cannot start VM." >&2
            echo "Minimum required: 256MB available, have: ${available_mem}MB" >&2
            exit 1
        fi
    else
        # For Ubuntu and other OS, use standard memory allocation
        if [ "$available_mem" -ge 8192 ]; then
            vm_memory=4096  # 4GB for VMs when host has 8GB+
            echo "[MEMORY] High memory detected, allocating: ${vm_memory}MB" >&2
        elif [ "$available_mem" -ge 4096 ]; then
            vm_memory=2048  # 2GB for VMs when host has 4-8GB
            echo "[MEMORY] Moderate memory detected, allocating: ${vm_memory}MB" >&2
        elif [ "$available_mem" -ge 2048 ]; then
            vm_memory=1024  # 1GB for VMs when host has 2-4GB
            echo "[MEMORY] Limited memory detected, allocating: ${vm_memory}MB" >&2
        elif [ "$available_mem" -ge 1024 ]; then
            vm_memory=512   # 512MB for VMs when host has 1-2GB
            echo "[MEMORY] Low memory detected, allocating minimal: ${vm_memory}MB" >&2
            echo "[WARNING] Ubuntu may struggle with only ${vm_memory}MB RAM" >&2
        elif [ "$available_mem" -ge 512 ]; then
            vm_memory=256   # 256MB absolute minimum for non-Alpine
            echo "[MEMORY] Very low memory! Allocating absolute minimum: ${vm_memory}MB" >&2
            echo "[WARNING] VM may be unstable with only ${vm_memory}MB RAM" >&2
        else
            echo "ERROR: Insufficient memory available (${available_mem}MB). Cannot start VM." >&2
            echo "Minimum required: 512MB available, have: ${available_mem}MB" >&2
            exit 1
        fi
    fi
    
    echo "$vm_memory"
}

# --- Helper: Check KVM availability ---
check_kvm() {
    if [ -e /dev/kvm ] && [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
        echo "[KVM] KVM acceleration available"
        return 0
    else
        echo "[KVM] KVM not available, falling back to software emulation (slower)"
        return 1
    fi
}

# --- Smart installation helper for apt-based systems ---
smart_apt_install() {
    local package="$1"
    local display_name="$2"
    
    echo "[INSTALL] Installing ${display_name} via apt..."
    
    # First try: Install without updating package lists (much faster if cache is recent)
    if apt-get install -y -qq "$package" 2>/dev/null; then
        echo "[INSTALL] ${display_name} installed successfully (no update needed)"
        return 0
    fi
    
    # Second try: Update package lists and retry (only if first attempt failed)
    echo "[INSTALL] Direct install failed, updating package lists and retrying..."
    if apt-get update -qq && apt-get install -y -qq "$package"; then
        echo "[INSTALL] ${display_name} installed successfully (after update)"
        return 0
    fi
    
    echo "ERROR: Failed to install ${display_name}"
    return 1
}

# --- Check and install genisoimage ---
install_genisoimage() {
    if command -v apt-get >/dev/null 2>&1; then
        smart_apt_install "genisoimage" "genisoimage" || exit 1
    elif command -v apk >/dev/null 2>&1; then
        echo "[INSTALL] Installing genisoimage via apk..."
        apk add --no-cache genisoimage
    elif command -v yum >/dev/null 2>&1; then
        echo "[INSTALL] Installing genisoimage via yum..."
        yum install -y -q genisoimage
    elif command -v dnf >/dev/null 2>&1; then
        echo "[INSTALL] Installing genisoimage via dnf..."
        dnf install -y -q genisoimage
    else
        echo "ERROR: No supported package manager found. Install genisoimage manually."
        exit 1
    fi
}

# --- Check and install qemu-img if needed ---
install_qemu_img() {
    if command -v apt-get >/dev/null 2>&1; then
        smart_apt_install "qemu-utils" "qemu-utils" || exit 1
    elif command -v apk >/dev/null 2>&1; then
        echo "[INSTALL] Installing qemu-img via apk..."
        apk add --no-cache qemu-img
    elif command -v yum >/dev/null 2>&1; then
        echo "[INSTALL] Installing qemu-img via yum..."
        yum install -y -q qemu-img
    elif command -v dnf >/dev/null 2>&1; then
        echo "[INSTALL] Installing qemu-img via dnf..."
        dnf install -y -q qemu-img
    else
        echo "ERROR: No supported package manager found. Install qemu-img manually."
        exit 1
    fi
}

# --- Check and install QEMU system emulator if needed ---
install_qemu_system() {
    if command -v apt-get >/dev/null 2>&1; then
        smart_apt_install "qemu-system-x86" "qemu-system-x86" || exit 1
    elif command -v apk >/dev/null 2>&1; then
        echo "[INSTALL] Installing qemu-system-x86_64 via apk..."
        apk add --no-cache qemu-system-x86_64
    elif command -v yum >/dev/null 2>&1; then
        echo "[INSTALL] Installing qemu-system-x86 via yum..."
        yum install -y -q qemu-system-x86
    elif command -v dnf >/dev/null 2>&1; then
        echo "[INSTALL] Installing qemu-system-x86 via dnf..."
        dnf install -y -q qemu-system-x86
    else
        echo "ERROR: No supported package manager found. Install QEMU manually."
        exit 1
    fi
}

# --- Pre-flight checks ---
if ! command -v genisoimage >/dev/null 2>&1; then
    echo "[CHECK] genisoimage not found, installing..."
    install_genisoimage
else
    echo "[CHECK] genisoimage already installed"
fi

if ! command -v qemu-img >/dev/null 2>&1; then
    echo "[CHECK] qemu-img not found, installing..."
    install_qemu_img
else
    echo "[CHECK] qemu-img already installed"
fi

if ! command -v qemu-system-x86_64 >/dev/null 2>&1; then
    echo "[CHECK] qemu-system-x86_64 not found, installing..."
    install_qemu_system
else
    echo "[CHECK] qemu-system-x86_64 already installed"
fi

# --- Functions ---
find_available_port() {
    local start_port="$1"
    local port="$start_port"
    local max_attempts=100
    
    while [ $((port - start_port)) -lt $max_attempts ]; do
        if ! ss -tlnp 2>/dev/null | grep -q ":${port} " && \
           ! netstat -tlnp 2>/dev/null | grep -q ":${port} " && \
           ! lsof -i :${port} 2>/dev/null >/dev/null; then
            echo "$port"
            return 0
        fi
        port=$((port + 1))
    done
    
    echo "ERROR: No available ports found between ${start_port} and $((start_port + max_attempts - 1))"
    return 1
}

# --- Helper: Test if a specific port can be bound ---
test_port_binding() {
    local port="$1"
    local timeout=2
    
    # Try to actually bind to the port temporarily to verify it's free
    if command -v timeout >/dev/null 2>&1; then
        timeout "$timeout" nc -l -p "$port" 2>/dev/null &
    else
        nc -l -p "$port" 2>/dev/null &
    fi
    local nc_pid=$!
    sleep 0.5
    
    if kill -0 "$nc_pid" 2>/dev/null; then
        # Port is bindable
        kill "$nc_pid" 2>/dev/null
        wait "$nc_pid" 2>/dev/null
        return 0
    else
        # Port is in use
        wait "$nc_pid" 2>/dev/null
        return 1
    fi
}

resize_disk() {
    local disk_path="$1"
    local target_size="$2"
    
    echo "[RESIZE] Resizing disk to: ${target_size}"
    qemu-img resize "${disk_path}" "${target_size}" || {
        echo "ERROR: Failed to resize disk image"
        exit 1
    }
    echo "[RESIZE] Disk resized successfully to ${target_size}"
}

create_cloud_init_iso() {
    local target_dir="$1"
    
    # Convert to absolute path
    target_dir=$(cd "$target_dir" 2>/dev/null && pwd || echo "$target_dir")
    local iso_path="${target_dir}/${ISO_FILE}"
    
    # Skip if ISO already exists
    if [ -f "${iso_path}" ]; then
        echo "[ISO] Cloud-init ISO already exists, skipping creation"
        return 0
    fi
    
    echo "[ISO] Creating cloud-init ISO..."
    local workdir="${target_dir}/cloud-init-source"
    mkdir -p "${workdir}"
    
    cd "${workdir}" || exit 1

    cat > user-data << CLOUDEOF
#cloud-config
password: ${DEFAULT_PASSWORD}
chpasswd:
  expire: False
ssh_pwauth: True

# Enable root login
user: ${CLOUD_USER}
disable_root: false

# Configure SSH for root login
write_files:
  - path: /etc/ssh/sshd_config.d/99-enable-root-login.conf
    content: |
      PermitRootLogin yes
      PasswordAuthentication yes
    permissions: '0644'
    owner: root:root

runcmd:
  - systemctl restart ssh 2>/dev/null || service ssh restart 2>/dev/null || /etc/init.d/sshd restart 2>/dev/null || true
CLOUDEOF

    cat > meta-data << METAEOF
instance-id: ${HOSTNAME_PREFIX}-cloudimg-$(date +%s)
local-hostname: ${HOSTNAME_PREFIX}-vm
METAEOF

    # Use full path for output
    genisoimage -output "${iso_path}" -volid cidata -joliet -rock user-data meta-data
    
    # Check if genisoimage succeeded
    if [ $? -ne 0 ]; then
        echo "ERROR: genisoimage failed"
        cd "${target_dir}" || exit 1
        rm -rf "${workdir}"
        exit 1
    fi
    
    # Return to target directory and cleanup
    cd "${target_dir}" || exit 1
    rm -rf "${workdir}"
    
    if [ -f "${iso_path}" ]; then
        echo "[ISO] Cloud-init ISO created successfully at: ${iso_path}"
    else
        echo "ERROR: Failed to create ISO at: ${iso_path}"
        exit 1
    fi
}

run_vm_with_retry() {
    local img_path="$1"
    local iso_path="$2"
    local initial_port="$3"
    local vm_memory="$4"
    local use_kvm="$5"
    local cpu_cores="$6"
    
    # Convert to absolute paths safely
    if [ -d "$(dirname "$img_path")" ]; then
        img_path=$(cd "$(dirname "$img_path")" && pwd)/$(basename "$img_path")
    else
        img_path="$(pwd)/${img_path#./}"
    fi
    
    if [ -d "$(dirname "$iso_path")" ]; then
        iso_path=$(cd "$(dirname "$iso_path")" && pwd)/$(basename "$iso_path")
    else
        iso_path="$(pwd)/${iso_path#./}"
    fi
    
    # Verify files exist before running
    if [ ! -f "${img_path}" ]; then
        echo "ERROR: Disk image not found: ${img_path}"
        echo "Current directory: $(pwd)"
        echo "Expected image: ${img_path}"
        exit 1
    fi
    if [ ! -f "${iso_path}" ]; then
        echo "ERROR: Cloud-init ISO not found: ${iso_path}"
        exit 1
    fi
    
    # Build QEMU command arguments (without port)
    local qemu_args="-drive file=${img_path},format=qcow2,if=virtio"
    qemu_args="${qemu_args} -cdrom ${iso_path}"
    qemu_args="${qemu_args} -m ${vm_memory}"
    qemu_args="${qemu_args} -smp ${cpu_cores}"
    qemu_args="${qemu_args} -device virtio-net,netdev=net0"
    qemu_args="${qemu_args} -nographic"
    
    # Add KVM if available and requested
    if [ "$use_kvm" = "true" ]; then
        qemu_args="${qemu_args} -enable-kvm"
    fi
    
    local attempt=1
    local current_port="$initial_port"
    
    while [ "$attempt" -le "$MAX_RETRY_ATTEMPTS" ]; do
        echo "[RETRY] Attempt ${attempt}/${MAX_RETRY_ATTEMPTS} with port ${current_port}"
        
        echo "[VM] Starting QEMU with:"
        echo "  OS:    ${SELECTED_OS}"
        echo "  Disk:  ${img_path}"
        echo "  ISO:   ${iso_path}"
        echo "  RAM:   ${vm_memory}MB"
        echo "  CPU:   ${cpu_cores} core(s)"
        echo "  Port:  localhost:${current_port} -> VM:22"
        if [ "$use_kvm" = "true" ]; then
            echo "  KVM:   enabled"
        else
            echo "  KVM:   disabled (using emulation)"
        fi
        
        # Verify port is still free before attempting (with actual bind test)
        local port_available=false
        if test_port_binding "$current_port"; then
            port_available=true
        fi
        
        if [ "$port_available" = "true" ]; then
            # Try to run QEMU with this port
            qemu-system-x86_64 \
                -drive file="${img_path}",format=qcow2,if=virtio \
                -cdrom "${iso_path}" \
                -m "${vm_memory}" \
                -smp "${cpu_cores}" \
                -netdev user,id=net0,hostfwd=tcp::"${current_port}"-:22 \
                -device virtio-net,netdev=net0 \
                -nographic \
                $([ "$use_kvm" = "true" ] && echo "-enable-kvm") \
                2>/tmp/qemu_error_$$.log
            
            local qemu_exit_code=$?
            
            # Check if the error was port-related
            if [ $qemu_exit_code -ne 0 ] && [ -f /tmp/qemu_error_$$.log ]; then
                if grep -q "Could not set up host forward" /tmp/qemu_error_$$.log; then
                    echo "[RETRY] Port ${current_port} binding failed (race condition), retrying..."
                    rm -f /tmp/qemu_error_$$.log
                    
                    if [ "$attempt" -lt "$MAX_RETRY_ATTEMPTS" ]; then
                        # Find a new available port
                        local new_port=$(find_available_port $((current_port + 1)))
                        if [ $? -eq 0 ]; then
                            echo "[RETRY] Found new port: ${new_port}"
                            current_port="$new_port"
                        else
                            echo "[RETRY] No alternative ports available"
                            attempt="$MAX_RETRY_ATTEMPTS"  # Force exit
                        fi
                        
                        echo "[RETRY] Waiting ${RETRY_DELAY_SECONDS}s before next attempt..."
                        sleep "$RETRY_DELAY_SECONDS"
                        attempt=$((attempt + 1))
                        continue
                    else
                        echo "ERROR: Failed to start VM after ${MAX_RETRY_ATTEMPTS} attempts"
                        echo "Last error: Port binding conflict"
                        rm -f /tmp/qemu_error_$$.log
                        return 1
                    fi
                else
                    # Some other error occurred
                    echo "ERROR: QEMU failed with error:"
                    cat /tmp/qemu_error_$$.log
                    rm -f /tmp/qemu_error_$$.log
                    return 1
                fi
            fi
            
            # QEMU started successfully or exited normally
            rm -f /tmp/qemu_error_$$.log
            return $qemu_exit_code
        else
            echo "[RETRY] Port ${current_port} is not available (bind test failed), finding new port..."
            
            if [ "$attempt" -lt "$MAX_RETRY_ATTEMPTS" ]; then
                # Find a new available port
                local new_port=$(find_available_port $((current_port + 1)))
                if [ $? -eq 0 ]; then
                    echo "[RETRY] Found new port: ${new_port}"
                    current_port="$new_port"
                else
                    echo "[RETRY] No alternative ports available"
                    attempt="$MAX_RETRY_ATTEMPTS"  # Force exit
                fi
                
                echo "[RETRY] Waiting ${RETRY_DELAY_SECONDS}s before next attempt..."
                sleep "$RETRY_DELAY_SECONDS"
                attempt=$((attempt + 1))
            else
                echo "ERROR: Failed to start VM after ${MAX_RETRY_ATTEMPTS} attempts"
                echo "Last error: Port ${current_port} not available"
                return 1
            fi
        fi
    done
    
    return 1
}

# --- Main Logic ---
SELECTED_OS="$DEFAULT_OS"
CUSTOM_PORT=""
VM_NAME=""
DISK_SIZE="${DEFAULT_DISK_SIZE}"
CUSTOM_MEMORY=""
CUSTOM_CPU_CORES=""  # Initialize as empty (will use default if not specified)

# Parse arguments
while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help|-help|--h)
            show_help
            ;;
        --alpine)
            SELECTED_OS="alpine"
            shift
            ;;
        --ubuntu)
            SELECTED_OS="ubuntu"
            shift
            ;;
        # Add more OS flags here as needed:
        # --debian)
        #     SELECTED_OS="debian"
        #     shift
        #     ;;
        # --fedora)
        #     SELECTED_OS="fedora"
        #     shift
        #     ;;
        --port)
            if [ -n "$2" ] && [ "$2" -eq "$2" ] 2>/dev/null; then
                CUSTOM_PORT="$2"
                shift 2
            else
                echo "ERROR: --port requires a valid number"
                exit 1
            fi
            ;;
        --size)
            if [ -n "$2" ]; then
                DISK_SIZE="$2"
                shift 2
            else
                echo "ERROR: --size requires a valid size (e.g., 5G, 10G, 20G)"
                exit 1
            fi
            ;;
        --memory|--mem)
            if [ -n "$2" ] && [ "$2" -eq "$2" ] 2>/dev/null; then
                CUSTOM_MEMORY="$2"
                shift 2
            else
                echo "ERROR: --memory requires a valid number in MB"
                exit 1
            fi
            ;;
        --cpu)
            if [ -n "$2" ] && [ "$2" -eq "$2" ] 2>/dev/null; then
                CUSTOM_CPU_CORES="$2"
                shift 2
            else
                echo "ERROR: --cpu requires a valid number"
                exit 1
            fi
            ;;
        --no-kvm)
            NO_KVM="true"
            shift
            ;;
        --retry-attempts)
            if [ -n "$2" ] && [ "$2" -eq "$2" ] 2>/dev/null; then
                MAX_RETRY_ATTEMPTS="$2"
                shift 2
            else
                echo "ERROR: --retry-attempts requires a valid number"
                exit 1
            fi
            ;;
        --retry-delay)
            if [ -n "$2" ] && [ "$2" -eq "$2" ] 2>/dev/null; then
                RETRY_DELAY_SECONDS="$2"
                shift 2
            else
                echo "ERROR: --retry-delay requires a valid number in seconds"
                exit 1
            fi
            ;;
        *)
            if [ -z "$VM_NAME" ] && [ "${1#--}" = "$1" ]; then
                VM_NAME="$1"
                shift
            else
                echo "ERROR: Unknown argument: $1"
                echo "Usage: $0 [--alpine|--ubuntu] [vm-name] [--port N] [--size SIZE] [--memory MB] [--cpu N] [--no-kvm] [--retry-attempts N] [--retry-delay SECONDS]"
                echo "Try: $0 --help for more information"
                exit 1
            fi
            ;;
    esac
done

# Load OS configuration
echo "[SETUP] Selected OS: ${SELECTED_OS}"
get_os_config "$SELECTED_OS"

# Determine KVM usage
if [ "$NO_KVM" = "true" ]; then
    USE_KVM="false"
    echo "[KVM] KVM disabled by user request"
else
    if check_kvm; then
        USE_KVM="true"
    else
        USE_KVM="false"
    fi
fi

# Validate and set CPU cores
if [ -n "$CUSTOM_CPU_CORES" ]; then
    VM_CPU_CORES=$(validate_cpu_cores "$CUSTOM_CPU_CORES")
else
    VM_CPU_CORES="$DEFAULT_CPU_CORES"
    echo "[CPU] Using default CPU cores: ${VM_CPU_CORES} (host has $(get_host_cpu_cores))"
fi

# Calculate VM memory based on host availability and OS type
# Redirect stderr to stdout temporarily to capture the memory value
VM_MEMORY=$(calculate_vm_memory "$CUSTOM_MEMORY" "$SELECTED_OS" 2>&1)
MEMORY_EXIT_CODE=$?
# Display the informational messages that were on stderr
echo "$VM_MEMORY" | while IFS= read -r line; do
    if echo "$line" | grep -qE '^\[MEMORY\]|^\[WARNING\]'; then
        echo "$line" >&2
    fi
done
# Get just the number (last line)
VM_MEMORY=$(echo "$VM_MEMORY" | tail -n1)

if [ "$MEMORY_EXIT_CODE" -ne 0 ]; then
    exit 1
fi

# Determine starting port for search
if [ -n "$CUSTOM_PORT" ]; then
    START_PORT="$CUSTOM_PORT"
    echo "[PORT] Searching for available port starting from custom port: ${START_PORT}"
else
    START_PORT="$SSH_BASE_PORT"
    echo "[PORT] Searching for available port starting from default port: ${START_PORT}"
fi

# Find available port with fallback
SSH_PORT=$(find_available_port "$START_PORT")
if [ $? -ne 0 ]; then
    echo "$SSH_PORT"
    exit 1
fi

if [ "$SSH_PORT" != "$START_PORT" ]; then
    echo "[PORT] Port ${START_PORT} is in use, using fallback port: ${SSH_PORT}"
else
    echo "[PORT] Using port: ${SSH_PORT}"
fi

# Store the absolute path of the current directory
BASE_DIR=$(pwd)

# Ensure base image exists in current directory for reuse
if [ ! -f "${BASE_DIR}/${IMG_FILE}" ]; then
    echo "[SETUP] Downloading ${SELECTED_OS} base cloud image (will be cached for future use)..."
    wget -q --show-progress "${IMG_URL}" -O "${BASE_DIR}/${IMG_FILE}" || {
        echo "ERROR: Failed to download image from ${IMG_URL}"
        exit 1
    }
    echo "[SETUP] Base image cached as: ${BASE_DIR}/${IMG_FILE}"
else
    echo "[SETUP] Using cached base image: ${BASE_DIR}/${IMG_FILE}"
fi

if [ -z "$VM_NAME" ]; then
    # Temporary mode - everything in /tmp, destroyed after exit
    TMPDIR=$(mktemp -d /tmp/${HOSTNAME_PREFIX}-vm-tmp.XXXXXX)
    echo "[TEMP MODE] Using temporary directory: ${TMPDIR}"
    echo "[TEMP MODE] All data will be lost when VM shuts down"
    
    # Copy base image to temporary directory
    echo "[TEMP MODE] Copying base image..."
    cp "${BASE_DIR}/${IMG_FILE}" "${TMPDIR}/${IMG_FILE}"
    
    # Resize disk before first use
    resize_disk "${TMPDIR}/${IMG_FILE}" "${DISK_SIZE}"
    
    # Create cloud-init ISO
    create_cloud_init_iso "${TMPDIR}"
    
    # Run VM with retry logic
    run_vm_with_retry "${TMPDIR}/${IMG_FILE}" "${TMPDIR}/${ISO_FILE}" "${SSH_PORT}" "${VM_MEMORY}" "${USE_KVM}" "${VM_CPU_CORES}"
    
    # Cleanup
    echo "[TEMP MODE] Cleaning up temporary files..."
    rm -rf "${TMPDIR}"
    
else
    # Persistent mode - data survives between runs
    VMDIR="${BASE_DIR}/${HOSTNAME_PREFIX}-vm-${VM_NAME}"
    
    if [ ! -d "${VMDIR}" ]; then
        # First run with this name - create directory and copy base image
        echo "[PERSISTENT MODE] Creating new VM: ${VM_NAME} at ${VMDIR}"
        mkdir -p "${VMDIR}"
    else
        echo "[PERSISTENT MODE] Using existing VM directory: ${VM_NAME}"
    fi
    
    # Ensure disk image exists in the VM directory
    if [ ! -f "${VMDIR}/${IMG_FILE}" ]; then
        echo "[PERSISTENT MODE] Copying base image..."
        cp "${BASE_DIR}/${IMG_FILE}" "${VMDIR}/${IMG_FILE}"
        
        # Resize disk only on first creation
        resize_disk "${VMDIR}/${IMG_FILE}" "${DISK_SIZE}"
    else
        echo "[PERSISTENT MODE] Using existing disk image (size preserved)"
    fi
    
    # Ensure cloud-init ISO exists (creates if missing, even on resume)
    create_cloud_init_iso "${VMDIR}"
    
    # Run VM with retry logic and persistent data
    run_vm_with_retry "${VMDIR}/${IMG_FILE}" "${VMDIR}/${ISO_FILE}" "${SSH_PORT}" "${VM_MEMORY}" "${USE_KVM}" "${VM_CPU_CORES}"
    echo "[PERSISTENT MODE] VM data preserved in: ${VMDIR}"
fi