<script lang="ts">
  import { status, changelogOpen } from "./stores";
  import changelogRaw from "../../../CHANGELOG.md?raw";

  // Last dashboard version this browser has seen. Compared against the running
  // version (from /api/status) to decide whether to show the What's New modal.
  const STORAGE_KEY = "one-pace-last-seen-version";

  type Ver = [number, number, number];

  type Block =
    | { kind: "sub"; text: string }   // ### Added / Fixed / …
    | { kind: "item"; text: string }  // - bullet
    | { kind: "para"; text: string }; // prose line

  interface Section {
    title: string;
    date: string | null;
    maxVersion: Ver | null; // highest version mentioned in the heading
    unreleased: boolean;
    blocks: Block[];
  }

  function parseVer(s: string | null | undefined): Ver | null {
    const m = (s ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }

  const cmp = (a: Ver, b: Ver): number =>
    a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

  // Parses the constrained grammar CHANGELOG.md uses (## sections with an
  // optional em-dash date, ### sub-headings, - bullets with continuations).
  function parseChangelog(raw: string): Section[] {
    const sections: Section[] = [];
    let cur: Section | null = null;

    for (const line of raw.split("\n")) {
      const h = line.match(/^##\s+(.*)$/);
      if (h) {
        const [head, date] = h[1].split("—").map((s) => s.trim());
        const title = head.replace(/^\[|\]$/g, "").trim();
        // The highest version in the heading (range headings list it last).
        const versions = [...head.matchAll(/(\d+)\.(\d+)\.(\d+)/g)];
        const top = versions.length
          ? (versions.map((m) => [Number(m[1]), Number(m[2]), Number(m[3])] as Ver)
              .sort(cmp).pop() as Ver)
          : null;
        cur = {
          title,
          date: date || null,
          maxVersion: top,
          unreleased: /unreleased/i.test(title),
          blocks: [],
        };
        sections.push(cur);
        continue;
      }
      if (!cur) continue; // preamble before the first section

      const sub = line.match(/^###\s+(.*)$/);
      if (sub) {
        cur.blocks.push({ kind: "sub", text: sub[1].trim() });
        continue;
      }
      const item = line.match(/^-\s+(.*)$/);
      if (item) {
        cur.blocks.push({ kind: "item", text: item[1].trim() });
        continue;
      }
      const trimmed = line.trim();
      if (!trimmed) continue;
      const last = cur.blocks[cur.blocks.length - 1];
      if (/^\s{2,}/.test(line) && last?.kind === "item") {
        last.text += " " + trimmed; // bullet continuation line
      } else if (last?.kind === "para") {
        last.text += " " + trimmed;
      } else {
        cur.blocks.push({ kind: "para", text: trimmed });
      }
    }
    return sections;
  }

  // Minimal inline markdown → HTML (escape first; then bold / code / links).
  function fmt(text: string): string {
    return text
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, '<code class="font-mono text-[0.85em] bg-base-content/10 px-1 rounded">$1</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
  }

  const SUB_BADGE: Record<string, string> = {
    Added: "badge-success",
    Fixed: "badge-warning",
    Changed: "badge-info",
    Removed: "badge-error",
    Highlights: "badge-info",
  };

  const sections = parseChangelog(changelogRaw);

  let open = $state(false);
  let manual = $state(false); // opened via the navbar version badge → full history
  let showSections = $state<Section[]>([]);
  let dialogEl = $state<HTMLDialogElement | null>(null);
  let handled = false;

  // Manual open: show the whole changelog (skip empty sections).
  $effect(() => {
    if ($changelogOpen && !open) {
      showSections = sections.filter((s) => s.blocks.length > 0);
      manual = true;
      open = true;
    }
  });

  $effect(() => {
    const version = $status?.version;
    if (!version || handled) return;
    handled = true;

    const current = parseVer(version);
    if (!current) return;

    let lastSeen: Ver | null = null;
    try {
      lastSeen = parseVer(localStorage.getItem(STORAGE_KEY));
    } catch {}

    // First visit: remember the version quietly — don't greet a brand-new user
    // with the entire history.
    if (!lastSeen) {
      remember(version);
      return;
    }
    if (cmp(current, lastSeen) <= 0) return;

    const fresh = sections.filter(
      (s) =>
        (s.unreleased && s.blocks.length > 0) ||
        (s.maxVersion !== null && cmp(s.maxVersion, lastSeen!) > 0)
    );
    if (fresh.length === 0) {
      remember(version);
      return;
    }
    showSections = fresh;
    open = true;
  });

  $effect(() => {
    if (open) dialogEl?.showModal();
    else dialogEl?.close();
  });

  function remember(version: string) {
    try {
      localStorage.setItem(STORAGE_KEY, version);
    } catch {}
  }

  function dismiss() {
    open = false;
    manual = false;
    $changelogOpen = false;
    if ($status?.version) remember($status.version);
  }
</script>

<dialog bind:this={dialogEl} class="modal" onclose={dismiss}>
  <div class="modal-box max-w-2xl w-full deck-card">
    <div class="flex items-start justify-between gap-3">
      <div>
        <div class="eyebrow">{manual ? "Changelog" : "What's New"}</div>
        <h3 class="font-display text-lg">
          {manual ? `v${$status?.version}` : `Updated to v${$status?.version}`}
        </h3>
        {#if !manual}
          <p class="text-xs opacity-55">Changes since your last visit.</p>
        {/if}
      </div>
      <button class="btn btn-sm btn-circle btn-ghost" onclick={dismiss}>✕</button>
    </div>

    <div class="max-h-[60vh] overflow-y-auto flex flex-col gap-5 mt-4 pr-1">
      {#each showSections as s (s.title)}
        <section>
          <div class="flex items-baseline gap-2">
            <h4 class="font-display text-sm tracking-wide">
              {s.unreleased ? "Latest" : s.title}
            </h4>
            {#if s.date}<span class="text-[0.65rem] opacity-40 tabular-nums">{s.date}</span>{/if}
          </div>
          <div class="flex flex-col gap-1 mt-1">
            {#each s.blocks as b}
              {#if b.kind === "sub"}
                <div class="mt-1.5">
                  <span class="badge badge-sm badge-outline {SUB_BADGE[b.text] ?? 'badge-ghost'}">{b.text}</span>
                </div>
              {:else if b.kind === "item"}
                <div class="flex gap-2 text-sm leading-snug">
                  <span class="opacity-40 select-none">•</span>
                  <span>{@html fmt(b.text)}</span>
                </div>
              {:else}
                <p class="text-xs opacity-60 italic">{@html fmt(b.text)}</p>
              {/if}
            {/each}
          </div>
        </section>
      {/each}
    </div>

    <div class="modal-action">
      <button class="btn btn-sm btn-primary" onclick={dismiss}>Got it</button>
    </div>
  </div>
  <form method="dialog" class="modal-backdrop"><button onclick={dismiss}>close</button></form>
</dialog>
