#!/bin/sh

# --- Configuration ---
IMG_URL="https://cloud-images.ubuntu.com/noble/20260216/noble-server-cloudimg-amd64.img"
IMG_FILE="noble-server-cloudimg-amd64.img"
ISO_FILE="noble-cloud-init.iso"

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

if ! command -v genisoimage >/dev/null 2>&1; then
    echo "[CHECK] genisoimage not found, installing..."
    install_genisoimage
else
    echo "[CHECK] genisoimage already installed"
fi

# --- Functions ---
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
password: ubuntu
chpasswd:
  expire: False
ssh_pwauth: True
EOF

    cat > meta-data << EOF
instance-id: noble-cloudimg-$(date +%s)
local-hostname: noble-vm
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
    
    # Convert to absolute paths safely
    if [ -d "$(dirname "$img_path")" ]; then
        img_path=$(cd "$(dirname "$img_path")" && pwd)/$(basename "$img_path")
    else
        # If directory doesn't exist yet, use the path as-is
        img_path="$(pwd)/${img_path#./}"
    fi
    
    if [ -d "$(dirname "$iso_path")" ]; then
        iso_path=$(cd "$(dirname "$iso_path")" && pwd)/$(basename "$iso_path")
    else
        # If directory doesn't exist yet, use the path as-is
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
    
    qemu-system-x86_64 \
        -drive file="${img_path}",format=qcow2,if=virtio \
        -cdrom "${iso_path}" \
        -m 2048 \
        -netdev user,id=net0 \
        -device virtio-net,netdev=net0 \
        -nographic \
        -enable-kvm
}

# --- Main Logic ---
VM_NAME="$1"

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
    TMPDIR=$(mktemp -d /tmp/noble-vm-tmp.XXXXXX)
    echo "[TEMP MODE] Using temporary directory: ${TMPDIR}"
    
    # Copy base image to temporary directory
    echo "[TEMP MODE] Copying base image..."
    cp "${BASE_DIR}/${IMG_FILE}" "${TMPDIR}/${IMG_FILE}"
    
    # Create cloud-init ISO
    create_cloud_init_iso "${TMPDIR}"
    
    # Run VM
    run_vm "${TMPDIR}/${IMG_FILE}" "${TMPDIR}/${ISO_FILE}"
    
    # Cleanup
    echo "[TEMP MODE] Cleaning up..."
    rm -rf "${TMPDIR}"
    
else
    # Persistent mode - data survives between runs
    VMDIR="${BASE_DIR}/noble-vm-${VM_NAME}"
    
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
    else
        echo "[PERSISTENT MODE] Using existing disk image"
    fi
    
    # Ensure cloud-init ISO exists (creates if missing, even on resume)
    create_cloud_init_iso "${VMDIR}"
    
    # Run VM with persistent data
    run_vm "${VMDIR}/${IMG_FILE}" "${VMDIR}/${ISO_FILE}"
    echo "[PERSISTENT MODE] VM data preserved in: ${VMDIR}"
fi