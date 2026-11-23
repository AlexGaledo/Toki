import { useCallback, useEffect, useState } from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { Bell, BookOpen, Flag, FolderGit2, KeyRound, Wrench, Info, Palette, Plug, ShieldCheck, Sparkles, UserRound, type LucideIcon, LockKeyhole } from 'lucide-react';
import { Monitor, Smartphone } from 'lucide-react';
import { DevicesSection } from '../settings/DevicesSection';
import { PcRunnerSection } from '../settings/PcRunnerSection';
import { SecuritySection } from '../settings/SecuritySection';
import { useStore } from '../../store';
import { api, type HealthResponse } from '../../lib/api';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { DialogCloseButton, DialogShell, DialogTitle, cn } from '../ui';
import { useNewLayout } from '../../lib/newLayout';
import { AccountSection } from '../settings/AccountSection';
import { ClaudeSection } from '../settings/ClaudeSection';
import { BotsSection } from '../settings/BotsSection';
import { AppearanceSection } from '../settings/AppearanceSection';
import { AboutSection } from '../settings/AboutSection';
import { NotificationsSection } from '../settings/NotificationsSection';
import { KnowledgeSection } from '../settings/KnowledgeSection';
import { IntegrationsSection } from '../settings/IntegrationsSection';
import { ProjectsSection } from '../settings/ProjectsSection';
import { CredentialsSection } from '../settings/CredentialsSection';
import { McpServersSection } from '../settings/McpServersSection';
import { BotReportsSection } from '../settings/BotReportsSection';

export type SectionId = 'account' | 'security' | 'claude' | 'bots' | 'appearance' | 'about' | 'knowledge'
  | 'integrations'
  | 'projects'
  | 'tools'
  | 'reports'
  | 'devices'
  | 'pc-runner'
  | 'credentials'
  | 'notifications';

const SECTIONS: { id: SectionId; label: string; icon: LucideIcon }[] = [
  { id: 'account', label: 'Account', icon: UserRound },
  { id: 'security', label: 'Security', icon: LockKeyhole },
  { id: 'claude', label: 'Claude', icon: Sparkles },
  { id: 'bots', label: 'Bots', icon: ShieldCheck },
  { id: 'projects', label: 'Projects', icon: FolderGit2 },
  { id: 'tools', label: 'Tools', icon: Wrench },
  { id: 'reports', label: 'Reports', icon: Flag },
  { id: 'integrations', label: 'Connections', icon: Plug },
  { id: 'credentials', label: 'Logins', icon: KeyRound },
  { id: 'knowledge', label: 'Knowledge', icon: BookOpen },
  { id: 'devices', label: 'Devices', icon: Smartphone },
  { id: 'pc-runner', label: 'PC runner', icon: Monitor },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'about', label: 'About', icon: Info },
];

/** What a paired phone sees: the hub refuses a device's settings writes, secrets, account and integrations. */
const DEVICE_SECTIONS: readonly SectionId[] = ['devices', 'appearance', 'about'];

const SIDE_NAV_QUERY = '(min-width: 640px)';

let lastSection: SectionId = 'account';

function useHealth() {
  const approvals = useStore((s) => s.settings.approvals);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const refresh = useCallback(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);
  useEffect(refresh, [refresh, approvals]);
  return { health, refresh };
}

export function SettingsDialog({ section: opening, onClose }: { section?: SectionId; onClose: () => void }) {
  const device = useStore((s) => s.device);
  const sections = (device ? SECTIONS.filter((x) => DEVICE_SECTIONS.includes(x.id)) : SECTIONS);
  const [section, setSection] = useState<SectionId>(opening ?? (device && !DEVICE_SECTIONS.includes(lastSection) ? 'devices' : lastSection));
  const sideNav = useMediaQuery(SIDE_NAV_QUERY);
  const fresh = useNewLayout();
  const { health, refresh: refreshHealth } = useHealth();

  const providers = useStore((s) => s.providers);
  const providerId = useStore((s) => s.settings.provider);
  const bots = useStore((s) => s.bots);
  const list = providers?.providers ?? [];
  const inUse = new Set([providerId, ...bots.map((b) => b.provider ?? providerId)]);
  const watched = list.filter((p) => inUse.has(p.id));
  const claudeNeedsAttention = (watched.length ? watched : list.slice(0, 1)).some((p) => !p.check.ok);

  const select = (value: string) => {
    lastSection = value as SectionId;
    setSection(value as SectionId);
  };

  return (
    <DialogShell open onOpenChange={(o) => !o && onClose()} className="flex h-[min(680px,calc(100dvh-1.5rem))] w-[880px] flex-col overflow-hidden">
      <TabsPrimitive.Root
        value={section}
        onValueChange={select}
        orientation={sideNav ? 'vertical' : 'horizontal'}
        className="flex min-h-0 flex-1 flex-col sm:flex-row"
      >
        <aside className="flex shrink-0 flex-col px-3 pt-4 sm:w-52 sm:border-r sm:border-line sm:bg-card2/30 sm:pb-3 sm:pt-6">
          <div className="flex items-center justify-between px-2 pb-2 sm:pb-4">
            <DialogTitle>Settings</DialogTitle>
            <div className="sm:hidden"><DialogCloseButton /></div>
          </div>
          <TabsPrimitive.List aria-label="Settings sections" className="flex flex-wrap gap-1 py-1 sm:flex-col sm:flex-nowrap">
            {sections.map(({ id, label, icon: Icon }) => (
              <TabsPrimitive.Trigger
                key={id}
                value={id}
                className={fresh
                  ? 'flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-ui text-muted hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent data-[state=active]:bg-active data-[state=active]:text-fg sm:gap-2.5'
                  : 'flex shrink-0 items-center gap-1.5 rounded-sm px-2.5 py-1.5 text-ui text-muted hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent data-[state=active]:bg-active data-[state=active]:text-fg sm:gap-2.5 sm:px-3 sm:py-2'}
              >
                <Icon size={15} aria-hidden className="hidden shrink-0 sm:block" />
                {id === 'claude' && list.length > 1 ? 'Providers' : label}
                {id === 'claude' && claudeNeedsAttention && (
                  <>
                    <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full sm:ml-auto', fresh ? 'bg-needs' : 'bg-warn')} />
                    <span className="sr-only">(needs attention)</span>
                  </>
                )}
              </TabsPrimitive.Trigger>
            ))}
          </TabsPrimitive.List>
        </aside>

        <div className="relative min-h-0 min-w-0 flex-1 border-t border-line sm:border-t-0">
          <div className="absolute right-4 top-4 z-10 hidden sm:block"><DialogCloseButton /></div>
          <div className="h-full overflow-y-auto overscroll-contain">
            <TabsPrimitive.Content value="account" tabIndex={-1} className={PANEL}><AccountSection /></TabsPrimitive.Content>
            <TabsPrimitive.Content value="security" tabIndex={-1} className={PANEL}><SecuritySection /></TabsPrimitive.Content>
            <TabsPrimitive.Content value="claude" tabIndex={-1} className={PANEL}><ClaudeSection /></TabsPrimitive.Content>
            <TabsPrimitive.Content value="bots" tabIndex={-1} className={PANEL}><BotsSection health={health} onHealthStale={refreshHealth} /></TabsPrimitive.Content>
            <TabsPrimitive.Content value="integrations" tabIndex={-1} className={PANEL}><IntegrationsSection /></TabsPrimitive.Content>
            <TabsPrimitive.Content value="credentials" tabIndex={-1} className={PANEL}><CredentialsSection /></TabsPrimitive.Content>
            <TabsPrimitive.Content value="knowledge" tabIndex={-1} className={PANEL}><KnowledgeSection /></TabsPrimitive.Content>
            <TabsPrimitive.Content value="notifications" tabIndex={-1} className={PANEL}><NotificationsSection /></TabsPrimitive.Content>
            <TabsPrimitive.Content value="appearance" tabIndex={-1} className={PANEL}><AppearanceSection readOnly={device} /></TabsPrimitive.Content>
            <TabsPrimitive.Content value="about" tabIndex={-1} className={PANEL}><AboutSection health={health} /></TabsPrimitive.Content>
            <TabsPrimitive.Content value="tools" tabIndex={-1} className={PANEL}><McpServersSection /></TabsPrimitive.Content>
            <TabsPrimitive.Content value="reports" tabIndex={-1} className={PANEL}><BotReportsSection /></TabsPrimitive.Content>
            <TabsPrimitive.Content value="projects" tabIndex={-1} className={PANEL}><ProjectsSection /></TabsPrimitive.Content>
            <TabsPrimitive.Content value="devices" tabIndex={-1} className={PANEL}><DevicesSection /></TabsPrimitive.Content>
            <TabsPrimitive.Content value="pc-runner" tabIndex={-1} className={PANEL}><PcRunnerSection onOpenSecurity={() => select('security')} /></TabsPrimitive.Content>
          </div>
        </div>
      </TabsPrimitive.Root>
    </DialogShell>
  );
}

const PANEL = 'px-5 py-5 focus:outline-none sm:px-8 sm:py-7';
