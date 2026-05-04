#!/bin/sh

# --- Configuration ---
IMG_URL="https://dl-cdn.alpinelinux.org/alpine/v3.23/releases/cloud/generic_alpine-3.23.4-x86_64-bios-cloudinit-r0.qcow2"
IMG_FILE="alpine-cloudinit.qcow2"
ISO_FILE="alpine-cloud-init.iso"
SSH_BASE_PORT=2222
DEFAULT_DISK_SIZE="5G"

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
    local target_dir="$1"  # Directory where ISO will be placed
    
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

    cat > user-data << 'EOF'
#cloud-config
password: alpine
chpasswd:
  expire: False
ssh_pwauth: True

# Enable root login
user: root
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
  - systemctl restart ssh
EOF

    cat > meta-data << EOF
instance-id: alpine-cloudimg-$(date +%s)
local-hostname: alpine-vm
EOF

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
    echo "  Disk: ${img_path}"
    echo "  ISO:  ${iso_path}"
    echo "  SSH:  localhost:${ssh_port} -> VM:22"
    
    qemu-system-x86_64 \
        -drive file="${img_path}",format=qcow2,if=virtio \
        -cdrom "${iso_path}" \
        -m 2048 \
        -netdev user,id=net0,hostfwd=tcp::${ssh_port}-:22 \
        -device virtio-net,netdev=net0 \
        -nographic \
        -enable-kvm
}

# --- Main Logic ---
CUSTOM_PORT=""
VM_NAME=""
DISK_SIZE="${DEFAULT_DISK_SIZE}"

# Parse arguments
while [ $# -gt 0 ]; do
    case "$1" in
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
                echo "ERROR: --size requires a valid size (e.g., 5G, 10G)"
                exit 1
            fi
            ;;
        *)
            if [ -z "$VM_NAME" ]; then
                VM_NAME="$1"
                shift
            else
                echo "ERROR: Unknown argument: $1"
                exit 1
            fi
            ;;
    esac
done

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
    echo "[SETUP] Downloading base cloud image (will be cached for future use)..."
    wget -q --show-progress "${IMG_URL}" -O "${BASE_DIR}/${IMG_FILE}" || {
        echo "ERROR: Failed to download image"
        exit 1
    }
    echo "[SETUP] Base image cached as: ${BASE_DIR}/${IMG_FILE}"
else
    echo "[SETUP] Using cached base image: ${BASE_DIR}/${IMG_FILE}"
fi

if [ -z "$VM_NAME" ]; then
    # Temporary mode - everything in /tmp, destroyed after exit
    TMPDIR=$(mktemp -d /tmp/alpine-vm-tmp.XXXXXX)
    echo "[TEMP MODE] Using temporary directory: ${TMPDIR}"
    
    # Copy base image to temporary directory
    echo "[TEMP MODE] Copying base image..."
    cp "${BASE_DIR}/${IMG_FILE}" "${TMPDIR}/${IMG_FILE}"
    
    # Resize disk before first use
    resize_disk "${TMPDIR}/${IMG_FILE}" "${DISK_SIZE}"
    
    # Create cloud-init ISO
    create_cloud_init_iso "${TMPDIR}"
    
    # Run VM
    run_vm "${TMPDIR}/${IMG_FILE}" "${TMPDIR}/${ISO_FILE}" "${SSH_PORT}"
    
    # Cleanup
    echo "[TEMP MODE] Cleaning up..."
    rm -rf "${TMPDIR}"
    
else
    # Persistent mode - data survives between runs
    VMDIR="${BASE_DIR}/alpine-vm-${VM_NAME}"
    
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
    run_vm "${VMDIR}/${IMG_FILE}" "${VMDIR}/${ISO_FILE}" "${SSH_PORT}"
    echo "[PERSISTENT MODE] VM data preserved in: ${VMDIR}"
fi
