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
# ============================================================================

# --- Default Configuration ---
DEFAULT_OS="alpine"
SSH_BASE_PORT=2222
DEFAULT_DISK_SIZE="5G"
DEFAULT_MEMORY="2048"  # Will be auto-adjusted based on host RAM

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
  --no-kvm            Disable KVM acceleration
  -h, --help          Show this help

EXAMPLES:
  bash qemu.sh                           # Alpine, temp, auto-destroy
  bash qemu.sh dev                       # Alpine, persistent as "dev"
  bash qemu.sh --ubuntu                  # Ubuntu, temp
  bash qemu.sh --ubuntu web --size 10G   # Ubuntu, persistent, 10G disk
  bash qemu.sh --port 2222 --memory 4096 # Custom port & memory
  bash qemu.sh --no-kvm                  # Force software emulation

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
    local available_mem=$(get_available_memory_mb)
    
    echo "[MEMORY] Host available memory: ${available_mem}MB" >&2
    
    # If specific memory requested, try to honor it
    if [ -n "$requested_memory" ] && [ "$requested_memory" -gt 0 ]; then
        if [ "$requested_memory" -lt "$available_mem" ]; then
            # Leave at least 512MB for host
            local host_reserve=512
            local max_vm_mem=$((available_mem - host_reserve))
            if [ "$requested_memory" -le "$max_vm_mem" ]; then
                echo "[MEMORY] Using requested memory: ${requested_memory}MB" >&2
                echo "$requested_memory"
                return 0
            else
                echo "[MEMORY] Requested memory (${requested_memory}MB) too high, adjusting to ${max_vm_mem}MB" >&2
                echo "$max_vm_mem"
                return 0
            fi
        else
            echo "ERROR: Requested memory (${requested_memory}MB) exceeds available memory (${available_mem}MB)" >&2
            exit 1
        fi
    fi
    
    # Auto-calculate based on available memory
    local vm_memory
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
    elif [ "$available_mem" -ge 512 ]; then
        vm_memory=256   # 256MB absolute minimum
        echo "[MEMORY] Very low memory! Allocating absolute minimum: ${vm_memory}MB" >&2
        echo "[WARNING] VM may be unstable with only ${vm_memory}MB RAM" >&2
    else
        echo "ERROR: Insufficient memory available (${available_mem}MB). Cannot start VM." >&2
        echo "Minimum required: 512MB available, have: ${available_mem}MB" >&2
        exit 1
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

# --- Check and install genisoimage ---
install_genisoimage() {
    if command -v apt-get >/dev/null 2>&1; then
        echo "[INSTALL] Installing genisoimage via apt..."
        apt-get update -qq && apt-get install -y -qq genisoimage
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
        echo "[INSTALL] Installing qemu-utils via apt..."
        apt-get update -qq && apt-get install -y -qq qemu-utils
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
        echo "[INSTALL] Installing qemu-system-x86 via apt..."
        apt-get update -qq && apt-get install -y -qq qemu-system-x86
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

run_vm() {
    local img_path="$1"
    local iso_path="$2"
    local ssh_port="$3"
    local vm_memory="$4"
    local use_kvm="$5"
    
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
    
    echo "[VM] Starting QEMU with:"
    echo "  OS:    ${SELECTED_OS}"
    echo "  Disk:  ${img_path}"
    echo "  ISO:   ${iso_path}"
    echo "  RAM:   ${vm_memory}MB"
    echo "  Port:  localhost:${ssh_port} -> VM:22"
    if [ "$use_kvm" = "true" ]; then
        echo "  KVM:   enabled"
    else
        echo "  KVM:   disabled (using emulation)"
    fi
    
    # Build QEMU command
    set -- \
        -drive file="${img_path}",format=qcow2,if=virtio \
        -cdrom "${iso_path}" \
        -m "${vm_memory}" \
        -netdev user,id=net0,hostfwd=tcp::"${ssh_port}"-:22 \
        -device virtio-net,netdev=net0 \
        -nographic
    
    # Add KVM if available and requested
    if [ "$use_kvm" = "true" ]; then
        set -- "$@" -enable-kvm
    fi
    
    # Execute QEMU
    qemu-system-x86_64 "$@"
}

# --- Main Logic ---
SELECTED_OS="$DEFAULT_OS"
CUSTOM_PORT=""
VM_NAME=""
DISK_SIZE="${DEFAULT_DISK_SIZE}"
CUSTOM_MEMORY=""

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
        --no-kvm)
            NO_KVM="true"
            shift
            ;;
        *)
            if [ -z "$VM_NAME" ] && [ "${1#--}" = "$1" ]; then
                VM_NAME="$1"
                shift
            else
                echo "ERROR: Unknown argument: $1"
                echo "Usage: $0 [--alpine|--ubuntu] [vm-name] [--port N] [--size SIZE] [--memory MB] [--no-kvm]"
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

# Calculate VM memory based on host availability
# Redirect stderr to stdout temporarily to capture the memory value
VM_MEMORY=$(calculate_vm_memory "$CUSTOM_MEMORY" 2>&1)
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
    
    # Run VM
    run_vm "${TMPDIR}/${IMG_FILE}" "${TMPDIR}/${ISO_FILE}" "${SSH_PORT}" "${VM_MEMORY}" "${USE_KVM}"
    
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
    
    # Run VM with persistent data
    run_vm "${VMDIR}/${IMG_FILE}" "${VMDIR}/${ISO_FILE}" "${SSH_PORT}" "${VM_MEMORY}" "${USE_KVM}"
    echo "[PERSISTENT MODE] VM data preserved in: ${VMDIR}"
fi