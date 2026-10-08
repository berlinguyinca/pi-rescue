# Boot repair — GRUB / EFI / initramfs

Diagnose which stage fails first, then fix only that stage. Boot order is: firmware (BIOS/UEFI)
→ bootloader (GRUB/systemd-boot) → kernel + initramfs → init (systemd) → fstab mounts → target.

## Where did it stop?
- **Nothing at all, straight to firmware/BIOS menu or "no bootable device"**: firmware isn't
  finding an EFI entry. `efibootmgr -v` from a live USB (after `mount`ing the real root, see
  chroot below) to see/fix boot entries; check the disk is even selected in firmware boot order.
- **GRUB rescue prompt** (`grub rescue>`): GRUB's own files/config are missing or its embedded
  path to them is stale (common after a disk clone/resize). Needs a `grub-install` +
  `update-grub` from a chroot (below).
- **GRUB menu shows, kernel panics / "VFS: Unable to mount root fs"**: initramfs doesn't have
  the right driver (common after a storage controller change, e.g. RAID→AHCI in firmware, or a
  LUKS/LVM layer initramfs wasn't rebuilt for) or the root= UUID in grub.cfg is stale.
- **Kernel boots, then drops to emergency mode / asks for the root password**: a failed mount in
  `/etc/fstab` (wrong UUID after a disk swap, or a network/NFS mount with no `nofail`). Check
  `journalctl -b -1 -p err` from the live rescue to see exactly which mount failed.
- **Boots but a critical service loops/fails**: not a boot problem anymore — see kb/linux-triage.md
  "Service won't start".

## Chroot into the real system (do this before most fixes below)
```
mount /dev/sdXN /mnt                      # the real root partition
mount /dev/sdXM /mnt/boot/efi             # if separate ESP
for d in dev proc sys run; do mount --bind /$d /mnt/$d; done
chroot /mnt /bin/bash
```
LUKS-encrypted root: `cryptsetup luksOpen /dev/sdXN cryptroot` before the first `mount`, then
mount `/dev/mapper/cryptroot`. LVM: `vgchange -ay` first so the logical volume device nodes exist.

## Fixes, by stage (run inside the chroot)
- **GRUB missing/corrupt**: `grub-install /dev/sdX` (whole disk, not a partition — BIOS) or
  `grub-install --target=x86_64-efi --efi-directory=/boot/efi` (UEFI), then `update-grub`
  (Debian/Ubuntu) or `grub2-mkconfig -o /boot/grub2/grub.cfg` (RHEL-family).
- **Stale UUID in grub.cfg or fstab** (after cloning/resizing a disk): `blkid` to get the real
  current UUIDs, fix `/etc/fstab` and re-run `update-grub`.
- **initramfs missing the right driver / just stale**: `update-initramfs -u -k all` (Debian/Ubuntu)
  or `dracut -f --regenerate-all` (RHEL-family/dracut-based).
- **fstab mount failing non-critically**: add `nofail` (and `x-systemd.device-timeout=10` for
  network mounts) rather than deleting the line, unless the mount is genuinely gone for good.

## Secure Boot / Setup Mode gotcha
- A freshly re-installed GRUB/shim may need re-signing if Secure Boot is on and the previous
  signature cache is gone — if the firmware silently falls through to the next boot entry after
  `grub-install` looked clean, check Secure Boot status first (`mokutil --sb-state`) before
  assuming the install itself failed.

## Safety
- Mount the target read-only (`mount -o ro`) for the diagnosis pass; only remount `rw` for the
  specific fix. Never run `grub-install` against the wrong disk — double check `lsblk` first.
