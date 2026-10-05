import '../log-view/log-view.component.js';
import '../repo-list/repo-list.component.js';
import '../repo-settings/repo-settings.component.js';

import { provide } from '@lit/context';
import type { TemplateResult } from 'lit';
import { html } from 'lit';
import { customElement } from 'lit/decorators.js';
import { when } from 'lit/directives/when.js';

import { ManageStore, storeContext, StoreController } from '../../state/store.js';
import { BumperElement } from '../../utils/base.utils.js';
import styles from './app.component.css';

/** Application shell: run bar, repo list and log panel side by side, settings drawer. */
@customElement('bumper-app')
export class BumperApp extends BumperElement.withUtilities().withStyles(styles) {
  @provide({ context: storeContext })
  readonly store = new ManageStore();

  constructor() {
    super();
    // re-render on every store change
    new StoreController(this, () => this.store);
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.store.connect();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.store.disconnect();
  }

  protected override render(): TemplateResult {
    const { workspace, connected, running, selection, ignoreReleaseAge, error, busy } =
      this.store.state;
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
        <wa-button
          size="s"
          variant="brand"
          ?loading=${running}
          ?disabled=${selection.size === 0 || running || busy}
          @click=${() => this.store.start()}
        >
          <wa-icon slot="start" library="system" name="play"></wa-icon>
          Update ${selection.size > 0 ? `(${selection.size})` : ''}
        </wa-button>
      </header>
      ${when(
        error,
        message => html`
          <wa-callout variant="danger" size="s">
            <wa-icon slot="icon" library="system" name="circle-xmark"></wa-icon>
            ${message}
            <wa-button size="xs" appearance="plain" @click=${() => this.store.dismissError()}>
              dismiss
            </wa-button>
          </wa-callout>
        `
      )}
      <wa-split-panel position="38">
        <bumper-repo-list slot="start"></bumper-repo-list>
        <bumper-log-view slot="end"></bumper-log-view>
      </wa-split-panel>
      <bumper-repo-settings></bumper-repo-settings>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'bumper-app': BumperApp;
  }
}
