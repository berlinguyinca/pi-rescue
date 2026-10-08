# Disk SMART triage & recovery (SATA/NVMe, LVM/RAID, filesystems)

## First look
- `smartctl --scan` to enumerate devices, then `smartctl -H -A /dev/sdX` (SATA/USB) or
  `nvme smart-log /dev/nvme0` (NVMe). The overall-health line is a coarse signal; the
  attributes below are what actually predict failure.
- Attributes that matter: `Reallocated_Sector_Ct` (>0 ⇒ bad sectors already remapped),
  `Current_Pending_Sector` (>0 ⇒ sectors awaiting remap, read them now before they're lost),
  `Offline_Uncorrectable` (>0 ⇒ already lost data in those sectors), `Temperature_Celsius`
  (sustained >55°C shortens life). A PASSED health line with nonzero Reallocated/Pending is
  still a dying disk — the self-assessment lags real wear.

## If SMART looks bad: image before you touch anything else
- **Never run fsck or mount read-write on a disk with pending/reallocated sectors first.**
  Image it read-only to a known-good disk with `ddrescue /dev/sdX /mnt/backup/disk.img
  /mnt/backup/disk.logfile` (the logfile lets you resume/retry bad-sector passes separately
  from the easy ones — always give it a logfile). `ddrescue -r3` for a third pass on just the
  bad regions after the first pass finishes.
- Work on the image from here on: `losetup -fP --show disk.img` then operate on the loop device.

## Filesystem repair (on the image/loop device, not the raw failing disk)
- ext4: `e2fsck -fy /dev/loopXpN` (dry run first: `e2fsck -fn` to see what it would do).
- XFS: `xfs_repair -n /dev/loopXpN` (dry run), then without `-n` to actually repair.
- Btrfs: `btrfs check` (read-only by default; `--repair` is a last resort, has a history of
  making things worse on very damaged filesystems — prefer `btrfs restore` to pull files off
  without repairing in place).
- LVM: `pvscan --cache`, `vgchange -ay`, `lvs -a` if volumes aren't showing up after a disk swap.
- Software RAID: `mdadm --detail /dev/mdX`; a degraded array rebuilds with `mdadm --manage
  /dev/mdX --add /dev/sdY1` — only after confirming the *failed* member, not the good one.

## File recovery when the filesystem itself is too damaged to mount
- `photorec` (part of testdisk) on the image: signature-based recovery, works even with a
  destroyed filesystem; recovers files without names/paths into type-sorted folders.
- `testdisk` first if partitions themselves look wrong (lost partition table) — it can often
  rewrite a sane partition table without touching data.
- Recovered-but-overwritten files are gone; stop writing to the source disk the moment data
  loss is suspected (every write risks overwriting what you're trying to recover).

## NVMe specifics
- `nvme smart-log` reports `percentage_used` (wear indicator, vendor-normalized 0-100) and
  `media_errors` (nonzero ⇒ real problem). `nvme error-log` for the device's internal error
  history. NVMe failures are often total/sudden rather than SATA's gradual bad-sector creep —
  back up proactively once `percentage_used` crosses ~80, don't wait for symptoms.

## Safety
- All of the above is read-only against the original failing disk once imaging starts — every
  repair/recovery step operates on the image or loop device. Confirm before any `--repair`,
  `mdadm --add`, or write-mode `fsck`/`xfs_repair` run against a real device.
