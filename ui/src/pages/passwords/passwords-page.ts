import { consume } from "@lit/context";
import { state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { schedulePasswordClipboardClear } from "../../lib/passwords-vault/clipboard.ts";
import {
  addShowDeletedFlag,
  createInitialPasswordsVaultState,
  createPasswordsEntry,
  deletePasswordsEntry,
  generatePasswordsEntry,
  initializePasswordsVault,
  lockPasswordsVault,
  passwordsVaultErrorHint,
  purgePasswordsEntry,
  refreshPasswordsVault,
  restorePasswordsEntry,
  revealPasswordsEntry,
  unlockPasswordsVault,
  updatePasswordsEntry,
  type PasswordsEntryDraft as PasswordsApiDraft,
} from "../../lib/passwords-vault/index.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { renderPasswordsVault, type RevealedPasswordsEntry } from "./view.ts";

const REVEAL_HIDE_MS = 30_000;

type PasswordsEntryDraft = {
  itemRef?: string;
  revision?: number;
  website: string;
  siteLabel: string;
  account: string;
  label: string;
  password: string;
  notes: string;
};

function emptyDraft(): PasswordsEntryDraft {
  return {
    website: "",
    siteLabel: "",
    account: "",
    label: "",
    password: "",
    notes: "",
  };
}

function parseWebsite(
  value: string,
): { scheme: "https" | "http"; host: string; port: number } | null {
  let candidate = value.trim();
  if (!candidate) {
    return null;
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    return null;
  }
  if (!url.hostname) {
    return null;
  }
  return {
    scheme: url.protocol === "https:" ? "https" : "http",
    host: url.hostname.toLowerCase(),
    port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
  };
}

function websiteForEntry(entry: {
  originScheme: string;
  originHost: string;
  originPort: number;
}): string {
  const defaultPort = entry.originScheme === "https" ? 443 : 80;
  const port = entry.originPort === defaultPort ? "" : `:${entry.originPort}`;
  return `${entry.originScheme}://${entry.originHost}${port}`;
}

class PasswordsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private store = createInitialPasswordsVaultState();
  @state() private search = "";
  @state() private dialogMode: "add" | "edit" | null = null;
  @state() private draft: PasswordsEntryDraft = emptyDraft();
  @state() private formError: string | null = null;
  @state() private notice: string | null = null;
  @state() private revealed: Record<string, RevealedPasswordsEntry> = {};
  @state() private authPassphrase = "";
  @state() private authConfirm = "";
  @state() private authAutoLockSeconds = 300;
  @state() private notesMode: "keep" | "replace" | "clear" = "keep";

  private readonly revealTimers = new Map<string, NodeJS.Timeout>();

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: (change) => this.resetGatewayState(change.snapshot),
    onSnapshot: (change) => {
      if (change.initial) {
        this.resetGatewayState(change.snapshot);
      }
    },
    ensureInitialData: () => this.ensureInitialData(),
  });

  private resetGatewayState(snapshot?: ApplicationContext["gateway"]["snapshot"]) {
    this.clearRevealed();
    this.store = createInitialPasswordsVaultState({
      client: snapshot?.client ?? null,
      connected: snapshot?.phase === "connected",
    });
    this.dialogMode = null;
    this.formError = null;
    this.notice = null;
  }

  private get scopes(): readonly string[] {
    return this.gateway.snapshot?.hello?.auth?.scopes ?? [];
  }

  private get canManage(): boolean {
    const snapshot = this.gateway.snapshot;
    return (
      isGatewayMethodAdvertised(snapshot ?? {}, "vault.status") === true &&
      (this.scopes.includes("operator.vault") || this.scopes.includes("operator.admin"))
    );
  }

  private get canReveal(): boolean {
    return this.scopes.includes("operator.vault.reveal");
  }

  private ensureInitialData() {
    if (this.canManage && !this.store.loaded && !this.store.loading) {
      void this.refresh();
    }
  }

  private async refresh(): Promise<void> {
    const store = this.store;
    await refreshPasswordsVault(store, () => this.requestUpdate());
    if (this.store === store) {
      this.requestUpdate();
    }
  }

  private clearRevealed() {
    for (const timer of this.revealTimers.values()) {
      clearTimeout(timer);
    }
    this.revealTimers.clear();
    this.revealed = {};
  }

  private openAdd() {
    if (!this.canManage) {
      return;
    }
    this.notice = null;
    this.formError = null;
    this.draft = emptyDraft();
    this.notesMode = "replace";
    this.dialogMode = "add";
  }

  private openEdit(entry: (typeof this.store.entries)[number]) {
    if (!this.canManage) {
      return;
    }
    this.notice = null;
    this.formError = null;
    this.draft = {
      itemRef: entry.itemRef,
      revision: entry.revision,
      website: websiteForEntry(entry),
      siteLabel: entry.siteLabel,
      account: entry.account,
      label: entry.label ?? "",
      password: "",
      notes: "",
    };
    this.notesMode = "keep";
    this.dialogMode = "edit";
  }

  private closeDialog() {
    if (!this.store.busy) {
      this.dialogMode = null;
      this.formError = null;
    }
  }

  private patchDraft(patch: Partial<PasswordsEntryDraft>) {
    this.draft = { ...this.draft, ...patch };
    this.formError = null;
  }

  private async generatePassword() {
    const password = await generatePasswordsEntry(this.store);
    if (password) {
      this.draft = { ...this.draft, password };
      this.notice = t("passwords.generated");
    }
    this.requestUpdate();
  }

  private async loadNotes() {
    const itemRef = this.draft.itemRef;
    if (!this.canReveal || !itemRef || this.store.status?.state !== "unlocked") {
      return;
    }
    const result = await revealPasswordsEntry(this.store, itemRef, "reveal");
    if (!result) {
      this.requestUpdate();
      return;
    }
    this.draft = { ...this.draft, notes: result.notes };
    this.notesMode = "replace";
    this.notice = t("passwords.notesLoaded");
    this.requestUpdate();
  }

  private async submitDraft() {
    if (!this.canManage || !this.dialogMode) {
      return;
    }
    const origin = parseWebsite(this.draft.website);
    if (!origin) {
      this.formError = t("passwords.badWebsite");
      return;
    }
    if (!this.draft.siteLabel.trim()) {
      this.formError = t("passwords.siteLabelRequired");
      return;
    }
    if (!this.draft.account.trim()) {
      this.formError = t("passwords.accountRequired");
      return;
    }
    if (this.dialogMode === "add" && !this.draft.password) {
      this.formError = t("passwords.passwordRequired");
      return;
    }
    const store = this.store;
    const draft = this.draft;
    const originFields = {
      originScheme: origin.scheme,
      originHost: origin.host,
      originPort: origin.port,
    } as const;
    const notes =
      this.dialogMode === "add"
        ? draft.notes
        : this.notesMode === "keep"
          ? undefined
          : this.notesMode === "clear"
            ? ""
            : draft.notes;
    const apiDraft: PasswordsApiDraft = {
      siteLabel: draft.siteLabel,
      account: draft.account,
      label: draft.label,
      password: draft.password,
      ...(notes !== undefined ? { notes } : {}),
      ...originFields,
    };
    const saved =
      this.dialogMode === "add"
        ? await createPasswordsEntry(store, apiDraft)
        : await updatePasswordsEntry(store, {
            ...apiDraft,
            itemRef: draft.itemRef ?? "",
            revision: draft.revision ?? 0,
          });
    if (!saved) {
      const error = store.error;
      this.formError =
        (error ? passwordsVaultErrorHint(error) : null) ??
        error?.message ??
        t("passwords.saveFailed");
      this.requestUpdate();
      return;
    }
    this.dialogMode = null;
    this.notice = t("passwords.saved");
    await this.refresh();
  }

  private async reveal(entry: (typeof this.store.entries)[number]) {
    if (!this.canReveal || this.store.status?.state !== "unlocked") {
      return;
    }
    const result = await revealPasswordsEntry(this.store, entry.itemRef, "reveal");
    if (!result) {
      this.requestUpdate();
      return;
    }
    this.revealed = {
      ...this.revealed,
      [entry.itemRef]: { password: result.password, notes: result.notes },
    };
    const previous = this.revealTimers.get(entry.itemRef);
    if (previous) {
      clearTimeout(previous);
    }
    this.revealTimers.set(
      entry.itemRef,
      setTimeout(() => {
        const next = { ...this.revealed };
        delete next[entry.itemRef];
        this.revealed = next;
        this.revealTimers.delete(entry.itemRef);
      }, REVEAL_HIDE_MS),
    );
    this.notice = t("passwords.revealWarning");
    this.requestUpdate();
  }

  private hide(itemRef: string) {
    const timer = this.revealTimers.get(itemRef);
    if (timer) {
      clearTimeout(timer);
      this.revealTimers.delete(itemRef);
    }
    const next = { ...this.revealed };
    delete next[itemRef];
    this.revealed = next;
  }

  private async copy(entry: (typeof this.store.entries)[number]) {
    if (!this.canReveal || this.store.status?.state !== "unlocked") {
      return;
    }
    const result = await revealPasswordsEntry(this.store, entry.itemRef, "copy");
    if (!result) {
      this.requestUpdate();
      return;
    }
    try {
      await navigator.clipboard.writeText(result.password);
      schedulePasswordClipboardClear(result.password);
      this.notice = t("passwords.copied");
    } catch {
      this.notice = t("passwords.copyFailed");
    }
    this.requestUpdate();
  }

  private async removeEntry(entry: (typeof this.store.entries)[number]) {
    if (
      !this.canManage ||
      !(await showConfirmDialog({
        title: t("passwords.deleteTitle"),
        message: t("passwords.deleteMessage", { site: entry.siteLabel, account: entry.account }),
        confirmLabel: t("common.delete"),
        danger: true,
      }))
    ) {
      return;
    }
    const store = this.store;
    await deletePasswordsEntry(store, entry);
    if (store.error) {
      this.requestUpdate();
      return;
    }
    this.hide(entry.itemRef);
    this.notice = t("passwords.deletedNotice");
    await this.refresh();
  }

  private async purgeEntry(entry: (typeof this.store.entries)[number]) {
    if (
      !this.canManage ||
      !(await showConfirmDialog({
        title: t("passwords.purgeTitle"),
        message: t("passwords.purgeMessage"),
        confirmLabel: t("passwords.purge"),
        danger: true,
      }))
    ) {
      return;
    }
    const store = this.store;
    await purgePasswordsEntry(store, entry.itemRef);
    if (store.error) {
      this.requestUpdate();
      return;
    }
    this.notice = t("passwords.purgedNotice");
    await this.refresh();
  }

  private async restore(entry: (typeof this.store.entries)[number]) {
    if (!this.canManage) {
      return;
    }
    const store = this.store;
    await restorePasswordsEntry(store, entry.itemRef);
    if (store.error) {
      this.requestUpdate();
      return;
    }
    this.notice = t("passwords.restoredNotice");
    await this.refresh();
  }

  private async lock() {
    const store = this.store;
    this.clearRevealed();
    await lockPasswordsVault(store);
    this.notice = t("passwords.lockedNotice");
    await this.refresh();
  }

  private async initialize() {
    if (this.authPassphrase !== this.authConfirm) {
      this.formError = t("passwords.passphraseMismatch");
      return;
    }
    if (this.authPassphrase.length < 8) {
      this.formError = t("passwords.passphraseTooShort");
      return;
    }
    const store = this.store;
    const status = await initializePasswordsVault(
      store,
      this.authPassphrase,
      this.authAutoLockSeconds,
    );
    this.authPassphrase = "";
    this.authConfirm = "";
    if (status) {
      this.notice = t("passwords.setupComplete");
      await this.refresh();
    } else {
      this.requestUpdate();
    }
  }

  private async unlock() {
    const store = this.store;
    const status = await unlockPasswordsVault(store, this.authPassphrase);
    this.authPassphrase = "";
    if (status) {
      this.notice = t("passwords.unlockedNotice");
      await this.refresh();
      return;
    }
    this.requestUpdate();
  }

  private visibleEntries() {
    const query = this.search.trim().toLowerCase();
    if (!query) {
      return this.store.entries;
    }
    return this.store.entries.filter((entry) =>
      [entry.siteLabel, entry.originHost, entry.account, entry.label ?? ""].some((value) =>
        value.toLowerCase().includes(query),
      ),
    );
  }

  override render() {
    const entries = this.visibleEntries();
    return renderPasswordsVault({
      status: this.store.status,
      entries,
      audit: this.store.audit,
      loading: this.store.loading,
      busy: this.store.busy,
      loaded: this.store.loaded,
      error: this.store.error,
      notice: this.notice,
      canManage: this.canManage,
      canReveal: this.canReveal,
      search: this.search,
      showDeleted: this.store.showDeleted,
      dialogMode: this.dialogMode,
      draft: this.draft,
      formError: this.formError,
      revealed: this.revealed,
      authPassphrase: this.authPassphrase,
      authConfirm: this.authConfirm,
      authAutoLockSeconds: this.authAutoLockSeconds,
      notesMode: this.notesMode,
      onSearchChange: (value) => {
        this.search = value;
      },
      onToggleDeleted: (value) => {
        addShowDeletedFlag(this.store, value);
        void this.refresh();
      },
      onRefresh: () => void this.refresh(),
      onOpenAdd: () => this.openAdd(),
      onOpenEdit: (entry) => this.openEdit(entry),
      onCloseDialog: () => this.closeDialog(),
      onDraftChange: (patch) => this.patchDraft(patch),
      onSubmitDraft: () => void this.submitDraft(),
      onGenerate: () => void this.generatePassword(),
      onReveal: (entry) => void this.reveal(entry),
      onHide: (itemRef) => this.hide(itemRef),
      onCopy: (entry) => void this.copy(entry),
      onDelete: (entry) => void this.removeEntry(entry),
      onRestore: (entry) => void this.restore(entry),
      onPurge: (entry) => void this.purgeEntry(entry),
      onLock: () => void this.lock(),
      onAuthPassphraseChange: (value) => {
        this.authPassphrase = value;
        this.formError = null;
      },
      onAuthConfirmChange: (value) => {
        this.authConfirm = value;
        this.formError = null;
      },
      onAuthAutoLockChange: (value) => {
        this.authAutoLockSeconds = value;
      },
      onNotesModeChange: (mode) => {
        this.notesMode = mode;
        if (mode === "clear") {
          this.draft = { ...this.draft, notes: "" };
        }
      },
      onLoadNotes: () => void this.loadNotes(),
      onInitialize: () => void this.initialize(),
      onUnlock: () => void this.unlock(),
    });
  }

  override disconnectedCallback() {
    this.clearRevealed();
    super.disconnectedCallback();
  }
}

if (!customElements.get("openclaw-passwords-page")) {
  customElements.define("openclaw-passwords-page", PasswordsPage);
}
