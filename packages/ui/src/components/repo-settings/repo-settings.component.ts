import type { ConfigField } from '@enke.dev/bumper-core/config/config.schema.js';
import {
  GLOBAL_CONFIG_FIELDS,
  REPO_CONFIG_FIELDS,
} from '@enke.dev/bumper-core/config/config.schema.js';
import type { RepoConfig, RepoView } from '@enke.dev/bumper-core/manage/view.types.js';
import { consume } from '@lit/context';
import type { PropertyValues, TemplateResult } from 'lit';
import { html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { map } from 'lit/directives/map.js';

import { api } from '../../api/client.js';
import { ManageStore, storeContext, StoreController } from '../../state/store.js';
import { BumperElement } from '../../utils/base.utils.js';
import styles from './repo-settings.component.css';

const CUSTOM = '__custom__';

/** Drawer editing one repo's `~/.bumperrc` entry; the form is rendered from the config schema. */
@customElement('bumper-repo-settings')
export class BumperRepoSettings extends BumperElement.withUtilities().withStyles(styles) {
  @consume({ context: storeContext })
  store!: ManageStore;

  constructor() {
    super();
    // re-render on every store change
    new StoreController(this, () => this.store);
  }

  @state()
  private draft: RepoConfig | null = null;

  @state()
  private customBranch = false;

  @state()
  private skipVersionCheck = false;

  #editing: string | null = null;

  protected override willUpdate(_changed: PropertyValues): void {
    const editing = this.store.state.editing;
    if (editing !== this.#editing) {
      this.#editing = editing;
      const repo = this.store.repo(editing);
      this.draft = repo ? structuredClone(repo.config) : null;
      this.customBranch =
        repo?.config.branch !== undefined && !repo.branches.includes(repo.config.branch);
      if (editing !== null) {
        void api.config().then(config => {
          this.skipVersionCheck = config.skipVersionCheck ?? false;
        });
      }
    }
  }

  #set<K extends keyof RepoConfig>(key: K, value: RepoConfig[K] | undefined): void {
    if (this.draft === null) {
      return;
    }
    if (value === undefined) {
      const { [key]: _dropped, ...rest } = this.draft;
      this.draft = rest as RepoConfig;
    } else {
      this.draft = { ...this.draft, [key]: value };
    }
  }

  #renderField(field: ConfigField, repo: RepoView): TemplateResult | typeof nothing {
    const draft = this.draft as RepoConfig;
    switch (field.kind) {
      case 'string-list': {
        const value = (draft[field.key] as string[]).join('\n');
        return html`
          <wa-textarea
            label=${field.title}
            hint=${field.description}
            rows="4"
            resize="vertical"
            .value=${value}
            @change=${(event: Event) =>
              this.#set(
                field.key,
                (event.target as HTMLTextAreaElement).value
                  .split('\n')
                  .map(line => line.trim())
                  .filter(Boolean) as never
              )}
          ></wa-textarea>
        `;
      }
      case 'boolean':
        return html`
          <wa-switch
            .checked=${draft[field.key] as boolean}
            hint=${field.description}
            with-hint
            @change=${(event: Event) =>
              this.#set(field.key, (event.target as HTMLInputElement).checked as never)}
          >
            ${field.title}
          </wa-switch>
        `;
      case 'string': {
        const value = (draft[field.key] as string | undefined) ?? '';
        const selected = this.customBranch ? CUSTOM : value;
        return html`
          <wa-select
            label=${field.title}
            hint=${field.description}
            .value=${selected}
            @change=${(event: Event) => {
              const picked = (event.target as HTMLSelectElement).value;
              this.customBranch = picked === CUSTOM;
              this.#set(
                field.key,
                (picked === CUSTOM || picked === '' ? undefined : picked) as never
              );
            }}
          >
            <wa-option value="">current branch${repo.branch ? ` (${repo.branch})` : ''}</wa-option>
            <wa-option value=${CUSTOM}>custom…</wa-option>
            ${map(repo.branches, branch => html`<wa-option value=${branch}>${branch}</wa-option>`)}
          </wa-select>
          ${
            this.customBranch
              ? html`
                  <wa-input
                    label="Custom branch"
                    hint="Created from the current branch when it doesn't exist yet"
                    .value=${value}
                    required
                    @change=${(event: Event) =>
                      this.#set(
                        field.key,
                        ((event.target as HTMLInputElement).value.trim() || undefined) as never
                      )}
                  ></wa-input>
                `
              : nothing
          }
        `;
      }
      case 'boolean-map': {
        const modules = this.store.state.workspace?.modules ?? [];
        const current = draft.modules;
        return html`
          <div>
            <div class="wa-heading-xs">${field.title}</div>
            <div class="hint">${field.description}</div>
            <div class="modules">
              ${map(
                modules,
                module => html`
                  <span title=${module.title}>${module.id}</span>
                  <wa-select
                    size="s"
                    .value=${current[module.id] === undefined ? 'auto' : current[module.id] ? 'on' : 'off'}
                    @change=${(event: Event) => {
                      const picked = (event.target as HTMLSelectElement).value;
                      const { [module.id]: _dropped, ...rest } = current;
                      this.#set(
                        'modules',
                        picked === 'auto' ? rest : { ...rest, [module.id]: picked === 'on' }
                      );
                    }}
                  >
                    <wa-option value="auto">auto</wa-option>
                    <wa-option value="on">on</wa-option>
                    <wa-option value="off">off</wa-option>
                  </wa-select>
                `
              )}
            </div>
          </div>
        `;
      }
    }
  }

  async #save(repo: RepoView): Promise<void> {
    if (this.draft === null) {
      return;
    }
    await this.store.saveRepoConfig(repo.id, this.draft);
    if (this.store.state.error === null) {
      this.store.edit(null);
    }
  }

  protected override render(): TemplateResult {
    const repo = this.store.repo(this.store.state.editing);
    const [skip] = GLOBAL_CONFIG_FIELDS;
    return html`
      <wa-drawer
        label=${repo ? `Settings · ${repo.id}` : 'Settings'}
        placement="end"
        ?open=${repo !== undefined && this.draft !== null}
        @wa-hide=${(event: Event) => {
          if (event.target === event.currentTarget) {
            this.store.edit(null);
          }
        }}
      >
        ${
          repo && this.draft
            ? html`
                <form @submit=${(event: Event) => event.preventDefault()}>
                  <div class="hint">
                    ${repo.configured ? repo.path : `${repo.path} — not in ~/.bumperrc yet, showing defaults`}
                  </div>
                  ${map(REPO_CONFIG_FIELDS, field => this.#renderField(field, repo))}
                  <wa-details summary="Global settings" appearance="outlined">
                    ${
                      skip
                        ? html`
                            <wa-switch
                              .checked=${this.skipVersionCheck}
                              hint=${skip.description}
                              with-hint
                              @change=${(event: Event) => {
                                const checked = (event.target as HTMLInputElement).checked;
                                this.skipVersionCheck = checked;
                                void this.store.saveGlobal({ skipVersionCheck: checked });
                              }}
                            >
                              ${skip.title}
                            </wa-switch>
                          `
                        : nothing
                    }
                  </wa-details>
                </form>
                <footer slot="footer">
                  <wa-button appearance="plain" @click=${() => this.store.edit(null)}
                    >Cancel</wa-button
                  >
                  <wa-button
                    variant="brand"
                    ?disabled=${this.store.state.busy}
                    @click=${() => this.#save(repo)}
                  >
                    Save
                  </wa-button>
                </footer>
              `
            : nothing
        }
      </wa-drawer>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'bumper-repo-settings': BumperRepoSettings;
  }
}
