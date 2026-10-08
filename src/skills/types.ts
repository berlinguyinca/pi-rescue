// Shared types for pi-rescue skills.
//
// Skills are kept decoupled from pi's `ExtensionCommandContext` on purpose:
// `assist` dispatches skills from the `input` lifecycle event too, which only
// hands handlers an `ExtensionContext` (no command-only methods), and unit
// tests must be able to drive a skill with a fake IO that needs no pi runtime
// at all. `ioFromContext()` is the single adapter from pi's real context to
// the narrow `SkillIO` surface every skill is written against.
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Everything a skill needs to talk to the user, independent of pi's own context types. */
export interface SkillIO {
  /** One-line narration ("Looking at your system now…"). Never a raw log dump. */
  print(message: string): void;
  /**
   * The final plain-language report/finding. Distinct from `print()` because
   * `ctx.ui.notify()` (via pi's `showStatus`) collapses consecutive calls
   * into a single chat line when nothing else was added to the chat in
   * between — exactly what a confirm dialog followed by a "Skipped: …"
   * narration line would otherwise do to a report printed just before it.
   * `report()` always lands as its own, durable chat entry. See
   * `setReportSink()`/`ioFromContext()` below.
   */
  report(message: string): void;
  /** Ask for an explicit go/no-go before any destructive or outbound action. */
  confirm(title: string, message: string): Promise<boolean>;
  /** Ask exactly one simple multiple-choice question. Returns undefined if cancelled or no UI. */
  choose(title: string, options: string[]): Promise<string | undefined>;
}

/**
 * Sends a report as its own durable piece of output, bypassing `ctx.ui.notify`'s
 * status-line collapsing. Set once, from `extensions/index.ts` (the only place
 * with access to `pi.sendMessage`); `ioFromContext()` falls back to a plain
 * `notify()` when no sink has been installed (e.g. under `node --test`, or
 * before `activate()` has run).
 */
let reportSink: ((text: string) => void) | undefined;

/** Installs (or clears, with `undefined`) the process-wide report sink. */
export function setReportSink(sink: ((text: string) => void) | undefined): void {
  reportSink = sink;
}

/**
 * Adapts a real pi `ExtensionContext` (or the richer `ExtensionCommandContext`)
 * to `SkillIO`. In non-interactive modes (`print`/`json`, no UI attached)
 * `confirm` always resolves `false` so a gated fix can never silently run.
 */
export function ioFromContext(ctx: ExtensionContext): SkillIO {
  return {
    print(message: string): void {
      ctx.ui.notify(message, "info");
    },
    report(message: string): void {
      if (reportSink) {
        reportSink(message);
        return;
      }
      ctx.ui.notify(message, "info");
    },
    async confirm(title: string, message: string): Promise<boolean> {
      if (!ctx.hasUI) return false;
      return ctx.ui.confirm(title, message);
    },
    async choose(title: string, options: string[]): Promise<string | undefined> {
      if (!ctx.hasUI) return undefined;
      return ctx.ui.select(title, options);
    },
  };
}

/** The exact handler shape pi's `registerCommand()` expects. */
export type SkillCommand = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

/** A no-op IO used by tests that only care about the call log, not real output. */
export function collectingIO(
  log: string[] = [],
  reportLog: string[] = [],
): SkillIO & { log: string[]; reportLog: string[] } {
  return {
    log,
    reportLog,
    print(message: string): void {
      log.push(message);
    },
    report(message: string): void {
      reportLog.push(message);
    },
    async confirm(): Promise<boolean> {
      return false;
    },
    async choose(): Promise<string | undefined> {
      return undefined;
    },
  };
}
