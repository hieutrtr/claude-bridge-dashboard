import { Input } from "@/src/components/ui/input";
import { ThemeToggle } from "@/src/components/ui/theme-toggle";
import { DispatchDialog } from "@/src/components/dispatch-dialog";
import { DispatchTrigger } from "@/src/components/dispatch-trigger";

export function Topbar() {
  return (
    <header className="flex h-14 items-center gap-3 border-b border-[hsl(var(--border))] px-4">
      <div className="flex-1">
        <Input
          type="search"
          placeholder="Search… (coming in Phase 2)"
          aria-label="Search"
          disabled
          className="max-w-sm"
        />
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
