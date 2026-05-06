import { ThemeToggle } from "@/src/components/ui/theme-toggle";
import { DispatchDialog } from "@/src/components/dispatch-dialog";
import { DispatchTrigger } from "@/src/components/dispatch-trigger";
import { CommandPaletteTrigger } from "@/src/components/command-palette-trigger";

export function Topbar() {
  // P4-T05: the disabled "Search…" input was a Phase-1 placeholder for
  // the global search. The command palette delivers the actual surface,
  // so the input is replaced with `<CommandPaletteTrigger>`.
  return (
    <header className="flex h-14 items-center gap-3 border-b border-[hsl(var(--border))] px-4">
      <div className="flex-1">
        <CommandPaletteTrigger />
      </div>
      <DispatchTrigger />
      <ThemeToggle />
      <div
        aria-label="User menu placeholder"
        className="ml-2 h-8 w-8 rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--card))]"
      />
      <DispatchDialog />
    </header>
  );
}
