import '../log-view/log-view.component.js';
import '../repo-list/repo-list.component.js';
import '../repo-settings/repo-settings.component.js';

import type WaToast from '@awesome.me/webawesome/dist/components/toast/toast.js';
import { provide } from '@lit/context';
import type { TemplateResult } from 'lit';
import { html } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';

import type { Notice } from '../../state/store.js';
import { ManageStore, storeContext, StoreController } from '../../state/store.js';
import { BumperElement } from '../../utils/base.utils.js';
import type { ThemeMode } from '../../utils/theme.utils.js';
import { cycleTheme, storedTheme } from '../../utils/theme.utils.js';
import styles from './app.component.css';

/** Application shell: run bar, repo list and log panel side by side, settings drawer. */
@customElement('bumper-app')
export class BumperApp extends BumperElement.withUtilities().withStyles(styles) {
  @state()
  private theme: ThemeMode = storedTheme();

  @provide({ context: storeContext })
  readonly store = new ManageStore();

  constructor() {
    super();
    // re-render on every store change
    new StoreController(this, () => this.store);
  }

  @query('wa-toast')
  private readonly toast!: WaToast | null;

  #offNotice: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.store.connect();
    this.#offNotice = this.store.onNotice(notice => this.#showToast(notice));
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.store.disconnect();
    this.#offNotice?.();
  }

  // no auto-close: a notice stays until the user dismisses it
  #showToast({ message, variant }: Notice): void {
    const icon =
      variant === 'danger' ? 'circle-xmark' : variant === 'success' ? 'check' : 'circle-question';
    this.toast?.create(message, { variant, duration: 0, icon: { name: icon, library: 'system' } });
  }

  protected override render(): TemplateResult {
    const { workspace, connected, running, selection, ignoreReleaseAge, dryRun, busy } =
      this.store.state;
    // both modes start a run, so the mode picker is only useful when a run could start
    const cannotRun = selection.size === 0 || running || busy;
    return html`
      <header>
        <strong class="wa-heading-s">bumper manage</strong>
        <span class="root" title=${workspace?.root ?? ''}>${workspace?.root ?? ''}</span>
        <wa-badge variant=${connected ? 'success' : 'danger'} appearance="outlined" pill>
          ${connected ? 'connected' : 'offline'}
        </wa-badge>
        <span class="spacer"></span>
        <wa-button
          size="s"
          appearance="plain"
          title="Colour theme: auto follows the system"
          @click=${() => (this.theme = cycleTheme(this.theme))}
        >
          Theme: ${this.theme}
        </wa-button>
        <wa-button
          size="s"
          appearance="plain"
          ?disabled=${busy || running}
          @click=${() => this.store.rescan()}
        >
          <wa-icon slot="start" library="system" name="magnifying-glass"></wa-icon>
          Rescan
        </wa-button>
        <wa-checkbox
          size="s"
          .checked=${ignoreReleaseAge}
          ?disabled=${running}
          @change=${(event: Event) =>
            this.store.setIgnoreReleaseAge((event.target as HTMLInputElement).checked)}
        >
          Ignore minimum release age
        </wa-checkbox>
        <wa-button
          size="s"
          appearance="plain"
          ?disabled=${selection.size === 0 || running}
          @click=${() => this.store.clearSelection()}
        >
          Clear
        </wa-button>
        <wa-button-group label="Run">
          <wa-button
            size="s"
            variant="brand"
            ?loading=${running}
            ?disabled=${cannotRun}
            @click=${() => this.store.start()}
          >
            <wa-icon slot="start" library="system" name="play"></wa-icon>
            ${dryRun ? 'Dry run' : 'Update'} ${selection.size > 0 ? `(${selection.size})` : ''}
          </wa-button>
          <!-- the mode only picks what the main button does, like GitHub's draft pull request -->
          <wa-dropdown
            placement="bottom-end"
            @wa-select=${(event: CustomEvent<{ item: { value: string } }>) =>
              this.store.setDryRun(event.detail.item.value === 'dry-run')}
          >
            <wa-button slot="trigger" size="s" variant="brand" ?disabled=${cannotRun}>
              <wa-icon library="system" name="chevron-down" label="Run mode"></wa-icon>
            </wa-button>
            <wa-dropdown-item type="checkbox" value="update" .checked=${!dryRun}>
              <div class="mode">
                <strong>Update</strong>
                <span>Commit, run the checks, then push or hold for you</span>
              </div>
            </wa-dropdown-item>
            <wa-dropdown-item type="checkbox" value="dry-run" .checked=${dryRun}>
              <div class="mode">
                <strong>Dry run</strong>
                <span>Only report what would change; no checkout, commit or push</span>
              </div>
            </wa-dropdown-item>
          </wa-dropdown>
        </wa-button-group>
      </header>
      <wa-split-panel position="38">
        <bumper-repo-list slot="start"></bumper-repo-list>
        <bumper-log-view slot="end"></bumper-log-view>
      </wa-split-panel>
      <bumper-repo-settings></bumper-repo-settings>
      <wa-toast placement="bottom-start"></wa-toast>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'bumper-app': BumperApp;
  }
}
