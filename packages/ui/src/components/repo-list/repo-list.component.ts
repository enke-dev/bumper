import type { RepoView } from '@enke.dev/bumper-core/manage/view.types.js';
import { consume } from '@lit/context';
import type { TemplateResult } from 'lit';
import { html, nothing } from 'lit';
import { customElement } from 'lit/decorators.js';
import { map } from 'lit/directives/map.js';
import { when } from 'lit/directives/when.js';

import { ManageStore, storeContext, StoreController } from '../../state/store.js';
import { BumperElement } from '../../utils/base.utils.js';
import { ACTIVE, severityVariant, statusLabel, statusVariant } from '../../utils/status.utils.js';
import styles from './repo-list.component.css';

/** Tree of stages → repos; one checkbox per repo (no implicit cascade), selection shows the log. */
@customElement('bumper-repo-list')
export class BumperRepoList extends BumperElement.withUtilities().withStyles(styles) {
  @consume({ context: storeContext })
  store!: ManageStore;

  constructor() {
    super();
    // re-render on every store change
    new StoreController(this, () => this.store);
  }

  #onSelection(event: CustomEvent<{ selection: HTMLElement[] }>): void {
    const id = event.detail.selection[0]?.dataset['id'];
    if (id !== undefined) {
      void this.store.focus(id);
    }
  }

  #renderStatus(repo: RepoView): TemplateResult | typeof nothing {
    if (repo.status === undefined) {
      return nothing;
    }
    if (ACTIVE.has(repo.status)) {
      return html`<wa-spinner></wa-spinner><span class="detail">${statusLabel(repo.status)}</span>`;
    }
    return html`
      <wa-badge
        variant=${statusVariant(repo.status)}
        appearance="filled"
        pill
        title=${repo.detail ?? ''}
      >
        ${statusLabel(repo.status)}
      </wa-badge>
    `;
  }

  #renderDiagnostics(repo: RepoView): TemplateResult | typeof nothing {
    if (repo.diagnostics.length === 0) {
      return nothing;
    }
    const worst =
      repo.diagnostics.find(d => d.severity === 'error') ??
      repo.diagnostics.find(d => d.severity === 'warning') ??
      repo.diagnostics[0];
    const id = `diag-${repo.id.replace(/[^a-z0-9]/gi, '-')}`;
    return html`
      <wa-tag
        id=${id}
        size="s"
        variant=${severityVariant(worst?.severity ?? 'info')}
        appearance="outlined"
        pill
      >
        ${repo.diagnostics.length}
      </wa-tag>
      <wa-tooltip for=${id}>${repo.diagnostics.map(d => d.message).join(' · ')}</wa-tooltip>
    `;
  }

  #renderRepo(repo: RepoView): TemplateResult {
    const { selection, running } = this.store.state;
    const unsupported = repo.packageManager === null;
    return html`
      <wa-tree-item data-id=${repo.id} ?selected=${this.store.state.focused === repo.id}>
        <div class="repo ${unsupported ? 'unsupported' : ''}">
          <wa-checkbox
            size="s"
            .checked=${selection.has(repo.id)}
            ?disabled=${unsupported || running}
            @change=${(event: Event) =>
              this.store.toggle(repo.id, (event.target as HTMLInputElement).checked)}
          ></wa-checkbox>
          <span class="name" title=${repo.path}>${repo.id}</span>
          ${when(
            this.store.hasUpstreamChanges(repo.id),
            () =>
              html`<wa-badge variant="warning" appearance="outlined" pill
                >upstream changes</wa-badge
              >`
          )}
          ${this.#renderDiagnostics(repo)} ${this.#renderStatus(repo)}
          ${when(
            !unsupported && !running && repo.downstream.length > 0,
            () => html`
              <wa-button
                size="xs"
                appearance="plain"
                title="Select with dependents"
                @click=${(event: Event) => {
                  event.stopPropagation();
                  this.store.selectWithDependents(repo.id);
                }}
              >
                <wa-icon
                  library="system"
                  name="arrow-down"
                  label="Select with dependents"
                ></wa-icon>
              </wa-button>
            `
          )}
          <wa-button
            size="xs"
            appearance="plain"
            title="Settings"
            @click=${(event: Event) => {
              event.stopPropagation();
              this.store.edit(repo.id);
            }}
          >
            <wa-icon library="system" name="gear" label="Settings"></wa-icon>
          </wa-button>
        </div>
      </wa-tree-item>
    `;
  }

  protected override render(): TemplateResult {
    const workspace = this.store.state.workspace;
    if (workspace === null) {
      return html`<div class="empty"><wa-spinner></wa-spinner> scanning …</div>`;
    }
    if (workspace.repos.length === 0) {
      return html`<div class="empty">no git repositories under ${workspace.root}</div>`;
    }
    const byId = new Map(workspace.repos.map(repo => [repo.id, repo]));
    return html`
      <wa-tree selection="single" @wa-selection-change=${this.#onSelection}>
        ${map(
          workspace.stages,
          (stage, index) => html`
            <wa-tree-item expanded>
              <span class="stage">Stage ${index}</span>
              <wa-badge variant="neutral" appearance="outlined" pill>${stage.length}</wa-badge>
              ${map(stage, id => {
                const repo = byId.get(id);
                return repo ? this.#renderRepo(repo) : nothing;
              })}
            </wa-tree-item>
          `
        )}
      </wa-tree>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'bumper-repo-list': BumperRepoList;
  }
}
