# Zephyr thread awareness in Rowley CrossWorks

`zephyr_threads.js` is a CrossStudio *threads script*: it fills the Threads
window with the Zephyr thread list and reconstructs the register set of each
switched-out thread so that CrossWorks can show a proper call stack per
thread.

It implements the same algorithm as the J-Link GDBServer plugin in this
repository (`zephyr_plugin.c`), but it does not need the
`_kernel_thread_info_offsets` table: CrossStudio has the DWARF information of
the ELF file, so all structure offsets are taken from the real types.

This document also describes how to debug a Zephyr application that was built
outside of CrossWorks (with `west` / CMake) using an ST-LINK.

## 1. Build the application with thread info

```
CONFIG_DEBUG_THREAD_INFO=y
```

`DEBUG_THREAD_INFO` selects `THREAD_MONITOR` (the `_kernel.threads` list this
script walks) and `THREAD_NAME` (the `name` field). You can also enable those
two directly; the script degrades gracefully if `THREAD_NAME` is missing and
shows `thread@0x...` instead of a name.

Useful additions while debugging:

```
CONFIG_DEBUG=y
CONFIG_NO_OPTIMIZATIONS=y      # only if you can live with the size/speed cost
CONFIG_THREAD_STACK_INFO=y
```

Build as usual:

```
west build -b <board> path/to/app
```

The file to debug is `build/zephyr/zephyr.elf`.

## 2. Create the CrossWorks project

`File > New Project`, pick your device (e.g. an STM32 part), and choose the
**"An externally built executable"** template. Then set, in
`Project Properties`:

| Property group | Property | Value |
| --- | --- | --- |
| External Build Options | Executable File | `$(ProjectDir)/build/zephyr/zephyr.elf` |
| External Build Options | Build Command | `west build -b <board> $(ProjectDir)/app` |
| External Build Options | Clean Command | `west build -t pristine` (optional) |
| Debug | Threads Script File | `$(ProjectDir)/crossworks/zephyr_threads.js` |

`Build Command` is what makes CrossWorks call your external build instead of
compiling anything itself, so `F7` runs `west`/CMake. If you would rather keep
building from a terminal, leave it empty — only `Executable File` is required
for debugging.

If `west` is not on the PATH that CrossStudio inherits, use the absolute path
to the executable or wrap the call in a small shell script / batch file.

## 3. Connect the ST-LINK

`Target > Targets` (or the Targets window): select the **ST-LINK** target
interface and connect. Two properties are worth checking:

* **Target Interface Type** — set to `SWD`. Most STM32 boards only wire SWD,
  and the default may be JTAG.
* **ST-LINK DLL File** (Windows) — must point at `STLinkUSBDriver.dll` from
  the ST-LINK Utility / STM32CubeProgrammer installation if CrossWorks cannot
  find it by itself.
* **Connect With Reset** — helps on parts that are asleep or in a low power
  mode, but requires nRST to be wired on the debug connector.

Two ways to get the image onto the target:

* **Let CrossWorks flash it.** This uses the CrossWorks memory map and flash
  loader of the device you selected in the wizard, so that device must match
  the board.
* **Flash with west, then attach.** `west flash` followed by
  `Target > Attach Debugger` in CrossWorks. This avoids any memory-map
  mismatch and is the simplest route for a first setup — you get symbols,
  source, breakpoints and the Threads window without CrossWorks needing to
  know how to program your flash.

## 4. Threads window

Open `Debug > Threads` (or `View > Threads`). While the target is stopped and
the kernel is running you get one row per Zephyr thread:

```
Name        Prio  State      PC          Thread
idle        15    QUEUED     0x0800a1c2  0x20001a40
main        0     RUNNING    0x08001234  0x20001b80
logging     14    PENDING    0x0800a1c2  0x20001cc0
```

Clicking a thread switches the Call Stack, Locals and Register windows to that
thread's reconstructed context.

## What the script does, and why

Most of it is a direct translation of `zephyr_plugin.c`. The parts that do not
follow from symbol information — and are therefore the parts worth reading:

* **`z_sys_post_kernel` check.** Before this flag is set, `_kernel` and the
  thread list contain whatever was in RAM at reset. Walking them produces
  garbage entries, so the script shows nothing until the kernel is up.
* **PendSV stack unwinding.** `k_thread.callee_saved` holds r4–r11 and the
  thread's PSP. The PSP points at the *bottom* of the exception frame that the
  CPU stacked on the way into PendSV, so the caller-saved registers (r0–r3,
  r12, lr, pc, xPSR) are read from there, and the SP reported to the debugger
  is the PSP unwound past that frame.
* **Extended (FPU) frame.** If `arch.mode_exc_return` has the FType bit clear,
  the CPU also stacked s0–s15, FPSCR and a padding word: 72 more bytes to
  unwind. The field only exists with `CONFIG_ARM_STORE_EXC_RETURN`; without it
  there is no per-thread FPU context and the basic frame is always correct.
* **xPSR bit 9.** AAPCS wants an 8-byte aligned stack. When the CPU had to
  force that alignment on exception entry it pushed one extra padding word and
  records it in bit 9 of the stacked xPSR (EPSR on ARMv6-M, RETPSR on
  ARMv8-M). Forgetting this is the classic bug in hand-written RTOS awareness:
  backtraces are then *sporadically* off by one word, which is much more
  annoying to chase than being wrong all the time.
* **State decoding order.** `thread_state` is a bit field and a thread can be
  in several states at once, so the decoding is a prioritized chain, not a
  lookup table: NOT STARTED → SUSPENDED → PENDING → QUEUED (shown as RUNNING
  when it is the current thread) → ABORTING → DEAD.
* **`CONTROL.SPSEL == 0`.** The CPU is on the main stack, i.e. inside an
  exception or interrupt handler rather than in any thread. The script appends
  an `EXCEPTION/INTERRUPT` entry so the current backtrace is not silently
  attributed to the thread that happened to be interrupted.

## Adapting it

Two places depend on how your CrossStudio version exposes the target, and are
the first things to look at if something is empty:

* `liveRegisters()` and the `CONTROL` read use
  `TargetInterface.getRegister(name)`. If that is unavailable, the running
  thread falls back to its (stale) saved context and the handler-mode entry is
  not shown; everything else keeps working.
* `getregs()` returns 17 values in the order r0–r12, sp, lr, pc, xPSR. The
  array must match the order of the CPU Registers display. If your register
  window shows a different set, adjust `REG_COUNT` and the `REG_*` indices.

## Tests

The tricky arithmetic is covered by a mock harness that stubs the CrossStudio
API and runs the script against a synthetic memory image — no hardware
required:

```
node crossworks/tests/threads_test.js
```

It checks the basic/FPU/alignment stack unwinding combinations, the state
decoding chain, the missing-`THREAD_NAME` and missing-`mode_exc_return`
fallbacks, the handler-mode entry and the corrupt-list guard.

## Troubleshooting

**Threads window is empty.** The kernel has not reached `z_sys_post_kernel`
yet (stop somewhere in or after `main()`), or the build is missing
`CONFIG_DEBUG_THREAD_INFO=y`. If the list shows
`<no struct k_thread debug info ...>`, CrossStudio could not evaluate
`struct k_thread` at all — check that the ELF really is the one you built and
that debug information was not stripped.

**No symbols / no source for an externally built ELF.** Recent Zephyr SDK
toolchains emit DWARF 5 by default. CrossWorks supports it in current
releases; on an older CrossWorks, force the older format:

```
CONFIG_COMPILER_OPT="-gdwarf-4"
```

**Backtrace of a thread ends immediately or looks bogus.** Check the SP the
script computes against the thread's stack region. An off-by-one-word error
points at the xPSR bit 9 or the FPU frame handling; a wildly wrong SP usually
means the thread never ran (its `callee_saved.psp` is still 0 — the script
reports zeroed registers in that case rather than inventing a stack).

**The running thread shows stale values.** That is expected if
`TargetInterface.getRegister()` is not available — the current thread's
`callee_saved` copy is only updated on a context switch. Use the normal
Register window for the running thread.
