/*
 * Zephyr RTOS thread awareness for Rowley CrossWorks / CrossStudio.
 *
 * Port of the algorithm used by the J-Link GDBServer plugin in this
 * repository (zephyr_plugin.c) to the CrossStudio "Threads window"
 * JavaScript API.
 *
 * Copyright (c) 2024 Nordic Semiconductor ASA
 * Copyright (c) 2024 Commonwealth Scientific and Industrial Research Organisation
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Usage:
 *   Project Properties -> Debug -> "Threads Script File" = path to this file.
 *
 * Requires the application to be built with (see crossworks/README.md):
 *   CONFIG_DEBUG_THREAD_INFO=y   (selects THREAD_MONITOR and THREAD_NAME)
 *
 * Unlike the J-Link plugin this script does not use the
 * _kernel_thread_info_offsets table: CrossStudio has the DWARF info of the
 * ELF, so all offsets are derived from the real types via Debug.evaluate().
 * The parts that do *not* follow from symbol information - the PendSV stack
 * unwinding, the FPU (extended) exception frame, the forced 8-byte stack
 * alignment indicated by xPSR bit 9, the priority order of the thread state
 * flags and the handler-mode pseudo thread - are ported 1:1 from the plugin.
 */

/* ------------------------------------------------------------------ */
/* Zephyr thread_state bits, see zephyr/kernel/include/kernel_structs.h */
/* ------------------------------------------------------------------ */
var STATE_PENDING     = 1 << 1;
var STATE_NOT_STARTED = 1 << 2;
var STATE_DEAD        = 1 << 3;
var STATE_SUSPENDED   = 1 << 4;
var STATE_ABORTING    = 1 << 5;
var STATE_QUEUED      = 1 << 7;

/* EXC_RETURN.FType: 0 means an extended (FPU) frame was stacked */
var EXC_RETURN_FTYPE_MASK = 1 << 4;

/* CONTROL.SPSEL: 0 means the CPU is using MSP, i.e. handler mode */
var CONTROL_SPSEL = 1 << 1;

/* Exception frame sizes in bytes */
var BASIC_FRAME_SIZE    = 8 * 4;   /* r0-r3, r12, lr, pc, xpsr        */
var EXTENDED_FRAME_SIZE = 18 * 4;  /* s0-s15, fpscr, reserved padding */

/* Number of registers reported to CrossStudio, in CPU register display
 * order: r0..r12, sp, lr, pc, xpsr. Same count the J-Link plugin reports.
 */
var REG_COUNT = 17;
var REG_SP   = 13;
var REG_LR   = 14;
var REG_PC   = 15;
var REG_XPSR = 16;

/* Handle used for the "EXCEPTION/INTERRUPT" pseudo thread */
var HANDLE_EXCEPTION = 0;

/* Upper bound when walking the thread list, guards against corrupt memory */
var MAX_THREADS = 256;

/* Address of the currently running k_thread, 0 if unknown */
var current_base = 0;

/* Cached struct k_thread field offsets, rebuilt on every update() */
var off = null;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

/** Coerce whatever Debug.evaluate() returned into a JS number. */
function num(v)
{
  if (v === null || v === undefined)
    return 0;
  if (typeof v == "number")
    return v;
  var s = ("" + v).replace(/^\s+|\s+$/g, "");
  var n = (s.indexOf("0x") == 0 || s.indexOf("0X") == 0) ?
          parseInt(s.substring(2), 16) : parseInt(s, 10);
  return isNaN(n) ? 0 : n;
}

function hex(v)
{
  return "0x" + (v >>> 0).toString(16);
}

/** Debug.evaluate() that yields a number and never throws. */
function evalNum(expr)
{
  try {
    return num(Debug.evaluate(expr));
  } catch (e) {
    return 0;
  }
}

/** Debug.evaluate() that reports failure instead of a value. */
function evalOrNull(expr)
{
  try {
    var v = Debug.evaluate(expr);
    return (v === undefined) ? null : v;
  } catch (e) {
    return null;
  }
}

/** Read a 32-bit word from target memory. */
function readU32(addr)
{
  try {
    return num(TargetInterface.peekWord(addr)) >>> 0;
  } catch (e) {
    /* No TargetInterface in this context: go through the expression
     * evaluator instead. */
    return evalNum("*(unsigned long *)" + hex(addr)) >>> 0;
  }
}

/** Read a byte from target memory (word read + shift, works everywhere). */
function readU8(addr)
{
  var w = readU32(addr & ~3);
  return (w >>> ((addr & 3) * 8)) & 0xff;
}

function toSigned8(v)
{
  v &= 0xff;
  return (v > 127) ? v - 256 : v;
}

/** Expression addressing a field of the k_thread at 'base'. */
function tfield(base, field)
{
  return "((struct k_thread *)" + hex(base) + ")->" + field;
}

/** Offset of a k_thread field, or -1 if the field does not exist. */
function fieldOffset(field)
{
  var v = evalOrNull("(unsigned long)&((struct k_thread *)0)->" + field);
  if (v === null)
    return -1;
  return num(v);
}

/* Field readers: use the cached offset when we have one, otherwise fall
 * back to evaluating the field expression per thread. Both paths need the
 * DWARF type, the offset path is just considerably faster. */
function thdU32(base, offset, field)
{
  if (offset >= 0)
    return readU32(base + offset);
  return evalNum("(unsigned long)" + tfield(base, field)) >>> 0;
}

function thdU8(base, offset, field)
{
  if (offset >= 0)
    return readU8(base + offset);
  return evalNum(tfield(base, field)) & 0xff;
}

/* ------------------------------------------------------------------ */
/* Kernel introspection                                                */
/* ------------------------------------------------------------------ */

/**
 * Has the kernel been started?
 *
 * Before z_sys_post_kernel is set, _kernel and the thread list contain
 * garbage and walking them produces nonsense entries. The symbol is
 * optional: if it is not in the ELF we assume the kernel is up.
 */
function kernelStarted()
{
  var v = evalOrNull("z_sys_post_kernel");
  if (v === null)
    return true;
  return num(v) != 0;
}

/** Address of the currently running thread. */
function readCurrent()
{
  /* SMP-aware kernels keep the running thread per CPU. */
  var v = evalOrNull("(unsigned long)_kernel.cpus[0].current");
  if (v === null) /* pre-SMP kernels */
    v = evalOrNull("(unsigned long)_kernel.current");
  return (v === null) ? 0 : num(v) >>> 0;
}

/** Head of the singly linked list of all threads (CONFIG_THREAD_MONITOR). */
function readThreadListHead()
{
  return evalNum("(unsigned long)_kernel.threads") >>> 0;
}

/** Resolve and cache the k_thread field offsets. Returns false if the
 *  ELF has no usable struct k_thread debug information. */
function resolveOffsets()
{
  off = {
    name:         fieldOffset("name"),
    prio:         fieldOffset("base.prio"),
    thread_state: fieldOffset("base.thread_state"),
    next_thread:  fieldOffset("next_thread"),
    psp:          fieldOffset("callee_saved.psp"),
    v1:           fieldOffset("callee_saved.v1"),
    exc_return:   fieldOffset("arch.mode_exc_return")
  };

  /* next_thread is the one field we cannot work without, and it only
   * exists with CONFIG_THREAD_MONITOR=y. If the offset lookup itself is
   * unsupported by this CrossStudio version, fall back to expression
   * mode and probe the field directly. */
  if (off.next_thread < 0 &&
      evalOrNull("&((struct k_thread *)0)->next_thread") === null)
    return false;

  return true;
}

/**
 * Convert the Zephyr thread_state bit field into a descriptive string.
 *
 * The order matters, this is a prioritized chain rather than a lookup
 * table: a thread can be QUEUED and PENDING at the same time and the
 * more specific state has to win.
 */
function stateToString(base, state)
{
  if (state & STATE_NOT_STARTED)
    return "NOT STARTED";
  if (state & STATE_SUSPENDED)
    return "SUSPENDED";
  if (state & STATE_PENDING)
    return "PENDING";
  if (state & STATE_QUEUED)
    return (base == current_base) ? "RUNNING" : "QUEUED";
  if (state & STATE_ABORTING)
    return "ABORTING";
  if (state & STATE_DEAD)
    return "DEAD";
  return "UNKNOWN";
}

/** Thread name, empty string when CONFIG_THREAD_NAME is disabled. */
function threadName(base)
{
  if (off.name < 0)
    return "";

  var addr = base + off.name;
  var name = "";
  for (var i = 0; i < 32; i++) {
    var c = readU8(addr + i);
    if (c == 0)
      break;
    if (c < 0x20 || c > 0x7e)
      return ""; /* not a sane name, don't show garbage */
    name += String.fromCharCode(c);
  }
  return name;
}

/* ------------------------------------------------------------------ */
/* Register reconstruction                                             */
/* ------------------------------------------------------------------ */

/**
 * Did this thread stack an extended (FPU) exception frame?
 *
 * Zephyr stores the EXC_RETURN value of the switched-out thread in
 * arch.mode_exc_return (CONFIG_ARM_STORE_EXC_RETURN). FType == 0 means
 * the FPU context is on the stack.
 */
function usesExtendedFrame(base)
{
  if (off.exc_return < 0)
    return false;
  var exc_return = readU8(base + off.exc_return);
  return (exc_return & EXC_RETURN_FTYPE_MASK) == 0;
}

/**
 * Live CPU registers, used for the running thread and for the
 * handler-mode pseudo thread. Returns null when unavailable.
 */
function liveRegisters()
{
  var names = ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7",
               "r8", "r9", "r10", "r11", "r12", "sp", "lr", "pc", "xpsr"];
  var regs = new Array(REG_COUNT);
  try {
    for (var i = 0; i < REG_COUNT; i++)
      regs[i] = num(TargetInterface.getRegister(names[i]));
  } catch (e) {
    return null;
  }
  return regs;
}

/**
 * Rebuild the register set of a switched-out thread.
 *
 * Layout at the point where Zephyr's PendSV handler stopped the thread:
 *
 *   k_thread.callee_saved  r4-r11 and the PSP of the thread
 *   [PSP + 0x00]           r0, r1, r2, r3, r12, lr, pc, xpsr
 *   [PSP + 0x20]           s0-s15, fpscr, padding   (extended frame only)
 *   [.. + 4]               padding word             (xPSR bit 9 set)
 *
 * The PSP stored in callee_saved points at the *bottom* of the stacked
 * exception frame. The stack pointer the thread had before the exception
 * is that value plus the frame, so it has to be unwound before being
 * reported to the debugger - otherwise every backtrace starts one frame
 * too deep.
 */
function threadRegisters(base)
{
  var regs = new Array(REG_COUNT);
  var i;

  for (i = 0; i < REG_COUNT; i++)
    regs[i] = 0;

  var psp = thdU32(base, off.psp, "callee_saved.psp");
  if (psp == 0 || (psp & 3) != 0)
    return regs; /* never switched out, or bogus - don't invent a stack */

  /* Callee saved registers r4-r11 live in the thread struct itself */
  if (off.v1 >= 0) {
    for (i = 0; i < 8; i++)
      regs[4 + i] = readU32(base + off.v1 + i * 4);
  } else {
    for (i = 0; i < 8; i++)
      regs[4 + i] = evalNum("(unsigned long)" +
                            tfield(base, "callee_saved.v" + (i + 1))) >>> 0;
  }

  /* Caller saved registers were stacked by the CPU on exception entry */
  regs[0]        = readU32(psp + 0x00);
  regs[1]        = readU32(psp + 0x04);
  regs[2]        = readU32(psp + 0x08);
  regs[3]        = readU32(psp + 0x0c);
  regs[12]       = readU32(psp + 0x10);
  regs[REG_LR]   = readU32(psp + 0x14);
  regs[REG_PC]   = readU32(psp + 0x18);
  regs[REG_XPSR] = readU32(psp + 0x1c);

  /* Undo the stacking so SP describes the thread, not the exception */
  var sp = psp + BASIC_FRAME_SIZE;
  if (usesExtendedFrame(base))
    sp += EXTENDED_FRAME_SIZE;

  /* AAPCS requires an 8-byte aligned stack. When the CPU had to force
   * that alignment on exception entry it pushed one padding word and
   * records the fact in bit 9 of the stacked xPSR (EPSR on ARMv6-M,
   * RETPSR on ARMv8-M - same meaning). Miss this and backtraces are
   * sporadically off by one word.
   */
  if (regs[REG_XPSR] & (1 << 9))
    sp += 4;

  regs[REG_SP] = sp;
  return regs;
}

/** Program counter of a thread, for the PC column. */
function threadPC(base)
{
  if (base == current_base) {
    var live = liveRegisters();
    if (live !== null)
      return hex(live[REG_PC]);
    return "";
  }
  var psp = thdU32(base, off.psp, "callee_saved.psp");
  if (psp == 0 || (psp & 3) != 0)
    return "";
  return hex(readU32(psp + 0x18));
}

/* ------------------------------------------------------------------ */
/* CrossStudio Threads window entry points                             */
/* ------------------------------------------------------------------ */

function init()
{
  Threads.setColumns("Name", "Prio", "State", "PC", "Thread");
  Threads.setSortByNumber("Prio");
}

function update()
{
  Threads.clear();
  current_base = 0;

  /* Kernel not up yet: everything below would read garbage */
  if (!kernelStarted())
    return;

  if (!resolveOffsets()) {
    Threads.newqueue("Zephyr");
    Threads.add("<no struct k_thread debug info, need CONFIG_DEBUG_THREAD_INFO=y>",
                "", "", "", "", HANDLE_EXCEPTION);
    return;
  }

  current_base = readCurrent();

  var head = readThreadListHead();
  if (head == 0)
    return;

  Threads.newqueue("Zephyr Threads");

  var base = head;
  var guard = 0;
  while (base != 0) {
    if (guard++ >= MAX_THREADS) {
      /* Corrupt or circular list. Say so instead of silently pretending
       * this is the complete thread list. */
      Threads.add("<thread list truncated after " + MAX_THREADS + " entries>",
                  "", "", "", "", HANDLE_EXCEPTION);
      break;
    }

    var state = thdU8(base, off.thread_state, "base.thread_state");
    var prio  = toSigned8(thdU8(base, off.prio, "base.prio"));
    var name  = threadName(base);

    if (name == "")
      name = "thread@" + hex(base);

    Threads.add(name,
                "" + prio,
                stateToString(base, state),
                threadPC(base),
                hex(base),
                base);

    base = thdU32(base, off.next_thread, "next_thread");
  }

  /* CONTROL.SPSEL == 0 means the CPU is on the main stack, i.e. we are
   * inside an exception or interrupt handler, not in any thread. Show
   * that context as its own entry so the current backtrace is not
   * silently attributed to the interrupted thread.
   */
  var control = null;
  try {
    control = num(TargetInterface.getRegister("CONTROL"));
  } catch (e) {
    control = null;
  }
  if (control !== null && (control & CONTROL_SPSEL) == 0) {
    Threads.newqueue("Handler mode");
    Threads.add("EXCEPTION/INTERRUPT", "", "RUNNING", "", "",
                HANDLE_EXCEPTION);
  }
}

/**
 * Called when a thread is selected in the Threads window. Returns the
 * register values in CPU register display order.
 */
function getregs(handle)
{
  var base = num(handle);

  /* The running thread and the handler-mode entry describe the current
   * CPU state, their k_thread copy is stale. */
  if (base == HANDLE_EXCEPTION || base == current_base) {
    var live = liveRegisters();
    if (live !== null)
      return live;
    if (base == HANDLE_EXCEPTION)
      return new Array(REG_COUNT);
  }

  if (off === null && !resolveOffsets())
    return new Array(REG_COUNT);

  return threadRegisters(base);
}
