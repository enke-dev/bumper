import type { LogLine } from '@enke.dev/bumper-core/manage/view.types.js';
import { consume } from '@lit/context';
import type { PropertyValues, TemplateResult } from 'lit';
import { html, nothing } from 'lit';
import { customElement, query } from 'lit/decorators.js';
import { map } from 'lit/directives/map.js';
import { when } from 'lit/directives/when.js';

import { ManageStore, storeContext, StoreController } from '../../state/store.js';
import { parseAnsi } from '../../utils/ansi.utils.js';
import { BumperElement } from '../../utils/base.utils.js';
import { severityVariant, statusLabel, statusVariant } from '../../utils/status.utils.js';
import styles from './log-view.component.css';

/** The focused repo's output (ANSI rendered), its diagnostics and the run controls. */
@customElement('bumper-log-view')
export class BumperLogView extends BumperElement.withUtilities().withStyles(styles) {
  @consume({ context: storeContext })
  store!: ManageStore;

  constructor() {
    super();
    // re-render on every store change
    new StoreController(this, () => this.store);
  }

  @query('pre')
  private readonly output!: HTMLPreElement | null;

  #stickToBottom = true;

  protected override willUpdate(_changed: PropertyValues): void {
    const pre = this.output;
    // remember whether the user was at the bottom before new lines land
    this.#stickToBottom = !pre || pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
  }

  protected override updated(): void {
    if (this.#stickToBottom && this.output) {
      this.output.scrollTop = this.output.scrollHeight;
    }
  }

  #renderLine(line: LogLine): TemplateResult {
    return html`<span class=${line.stream}
      >${map(
        parseAnsi(line.line),
        span => html`<span class=${span.classes.join(' ')}>${span.text}</span>`
      )}</span
    > `;
  }

  protected override render(): TemplateResult {
    const { focused, logs, busy, diagnosing } = this.store.state;
    const repo = this.store.repo(focused);
    if (repo === undefined) {
      return html`<div class="empty">select a repository to see its log</div>`;
    }
    const status = repo.status;
    return html`
      <header>
        <span class="id">${repo.id}</span>
        ${when(
          status,
          s => html`
            <wa-badge variant=${statusVariant(s)} appearance="filled" pill
              >${statusLabel(s)}</wa-badge
            >
          `
        )}
        ${when(repo.detail, detail => html`<span class="detail">${detail}</span>`)}
        <span class="spacer"></span>
        <wa-button
          size="s"
          appearance="plain"
          title=${repo.diagnosed ? 'Re-run the git and registry checks' : 'Run the git and registry checks'}
          ?loading=${diagnosing.has(repo.id)}
          @click=${() => this.store.diagnose(repo.id)}
        >
          <wa-icon slot="start" library="system" name="magnifying-glass"></wa-icon>
          ${repo.diagnosed ? 'Re-check' : 'Check'}
        </wa-button>
        ${when(
          status === 'failed' || status === 'blocked',
          () => html`
            <wa-button
              size="s"
              ?disabled=${busy}
              @click=${() => this.store.control(repo.id, 'retry')}
            >
              Retry
            </wa-button>
          `
        )}
        ${when(
          status === 'blocked',
          () => html`
            <wa-button
              size="s"
              variant="warning"
              ?disabled=${busy}
              @click=${() => this.store.control(repo.id, 'run-anyway')}
            >
              Run anyway
            </wa-button>
          `
        )}
        ${when(
          status === 'awaiting-release',
          () => html`
            <wa-button
              size="s"
              ?disabled=${busy}
              @click=${() => this.store.control(repo.id, 'skip-waiting')}
            >
              Skip waiting
            </wa-button>
          `
        )}
      </header>
      ${
        repo.diagnostics.length > 0
          ? html`
              <ul class="diagnostics">
                ${map(
                  repo.diagnostics,
                  d => html`
                    <li>
                      <wa-badge variant=${severityVariant(d.severity)} appearance="outlined" pill
                        >${d.code}</wa-badge
                      >
                      ${d.message}
                    </li>
                  `
                )}
              </ul>
            `
          : nothing
      }
      ${
        logs.length === 0
          ? html`<div class="empty">no output yet</div>`
          : html`<pre>${map(logs, line => this.#renderLine(line))}</pre>`
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'bumper-log-view': BumperLogView;
  }
}
