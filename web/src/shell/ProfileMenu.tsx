// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/* ============================================================
   BATON — profile menu (spec D Rev 3 §2)
   Profile, settings, theme and the simple-mode toggle.
   ============================================================ */
import { useNavigate } from "react-router-dom";
import { LayoutList, Monitor, Moon, Settings, Sun, User, Users } from "lucide-react";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub,
  DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Prefs, Theme } from "@/hooks/usePrefs";
import { PersonAvatar } from "@/features/team/ui";


/** Demo only: act as another teammate to see what each role can do. */
export interface ViewAs {
  people: { id: string; name: string; role: string }[];
  current: string;
  onChange: (id: string) => void;
}

export function ProfileMenu({ name, hue, role, prefs, simpleMode, onSimpleMode, viewAs }: {
  name: string; hue: number; role: string | null; prefs: Prefs; simpleMode: boolean; onSimpleMode: (v: boolean) => void; viewAs?: ViewAs;
}) {
  const go = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={`Account: ${name}. Open profile menu`}
          className="grid size-8 shrink-0 place-items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background max-md:size-11">
          <PersonAvatar person={{ name, avatarHue: hue }} size={28} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="flex items-center gap-2.5 py-1.5">
          <PersonAvatar person={{ name, avatarHue: hue }} size={32} />
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-semibold">{name}</span>
            {role && <span className="block truncate text-[11px] font-normal text-muted-foreground">{role}</span>}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => go("/profile")}><User aria-hidden />Profile</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => go("/settings")}><Settings aria-hidden />Settings</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {prefs.resolvedTheme === "dark" ? <Moon aria-hidden /> : <Sun aria-hidden />}Theme
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={prefs.theme} onValueChange={(v) => prefs.setTheme(v as Theme)}>
              <DropdownMenuRadioItem value="system"><Monitor aria-hidden />System</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="light"><Sun aria-hidden />Light</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark"><Moon aria-hidden />Dark</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuCheckboxItem checked={simpleMode} onCheckedChange={(v) => onSimpleMode(v === true)}>
          <LayoutList aria-hidden />Simple mode
        </DropdownMenuCheckboxItem>
        {viewAs && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><Users aria-hidden />View as (demo)</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-72">
                <DropdownMenuRadioGroup value={viewAs.current} onValueChange={viewAs.onChange}>
                  {viewAs.people.map((p) => (
                    <DropdownMenuRadioItem key={p.id} value={p.id}>
                      <span className="min-w-0">
                        <span className="block truncate">{p.name}</span>
                        <span className="block truncate text-[11px] font-normal text-muted-foreground">{p.role}</span>
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
