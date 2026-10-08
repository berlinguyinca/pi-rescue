# GPU triage — NVIDIA (CUDA) and AMD (ROCm)

## First look (either vendor)
- NVIDIA: `nvidia-smi` — if it errors ("NVIDIA-SMI has failed... driver/library version
  mismatch", "No devices were found") the driver itself is the problem, not a specific job.
  `nvidia-smi -q` for full per-GPU detail (ECC errors, throttling reason, Xid events).
- AMD: `rocm-smi` and `rocminfo`. `dmesg | grep -i amdgpu` for ring-hang / reset events.
- Both: `lspci -k | grep -EA3 'VGA|3D'` to confirm the kernel driver actually bound to the card
  (vs. `nouveau`/`amdgpu` generic fallback still loaded instead of the proprietary stack).

## NVIDIA: driver/library version mismatch
- Classic cause: `apt upgrade` pulled a new `nvidia-driver-*`/`libnvidia-*` package but the
  kernel module wasn't reloaded (no reboot yet) or DKMS failed to rebuild against a new kernel.
  `cat /proc/driver/nvidia/version` vs `dpkg -l | grep nvidia-driver` — if they disagree, that's
  the mismatch. Fix: reboot (simplest), or `dkms status` to find a failed build and
  `dkms install -m nvidia -v <ver> -k $(uname -r)` to retry it.
- This is exactly what kb/hardening.md's auto-update blacklist (`nvidia-driver-*`, `libnvidia-*`,
  `nvidia-container*`) exists to prevent on a box that never auto-reboots — if you're triaging a
  box without that blacklist, this is the first thing to suspect after any unattended-upgrade run.
- Secure Boot + DKMS: NVIDIA's kernel module is usually unsigned; with Secure Boot enforcing,
  the module silently fails to load. `mokutil --sb-state`; either enroll the DKMS-generated MOK
  key (`mokutil --import /var/lib/dkms/mok.pub`, confirm at next reboot) or disable Secure Boot.

## NVIDIA: CUDA/container-specific
- `nvidia-container-cli info` to check the container toolkit sees the GPU at all before blaming
  a specific container. A job that worked yesterday and now gets "CUDA error: no kernel image is
  available for execution" after a driver bump usually needs the CUDA toolkit/pytorch build
  rebuilt or pinned back — the compute capability support matrix shifted.
- `nvidia-smi --query-gpu=pstate,clocks_throttle_reasons.active --format=csv` to check for
  thermal or power-cap throttling before assuming it's a software bug.

## AMD ROCm
- `rocminfo` not listing the GPU at all, but `lspci` sees it: the `amdgpu` kernel module may be
  blacklisted or an older `radeon` module claimed it first — check `lsmod | grep -E 'amdgpu|radeon'`.
- `ROCR_VISIBLE_DEVICES` **must** use the `GPU-<uuid>` form, not a bare index or bare unique_id —
  a bare unique_id silently selects no card and ROCm never reports an error, it just runs on
  nothing visible (or falls back to CPU). Get the correct id from `rocm-smi --showuniqueid`.
- ROCm version/kernel-module mismatches are rarer than NVIDIA's but follow the same pattern:
  `dpkg -l | grep rocm` vs. what `rocminfo` reports, and `dkms status` for `amdgpu-dkms`.

## Multi-GPU: card numbering disagreement
- A box can have DRM device numbering that runs backwards against PCI bus order (seen in
  practice on mixed/multi-vendor builds). Don't assume `nvidia-smi`'s GPU 0 is the same physical
  card as `rocm-smi`'s GPU 0 or the PCI slot order from `lspci` — cross-check by PCI bus id
  (`nvidia-smi --query-gpu=pci.bus_id --format=csv` / `rocm-smi --showbus`) before pulling a card
  or pinning a job to "GPU 0" based on one tool's numbering alone.

## Safety
- All of the above is read-only inspection. Driver reinstalls, DKMS rebuilds, and MOK enrollment
  change the system and should be confirmed explicitly before running, especially on a box with
  jobs already resident on the GPU (a driver reload can kill them).
