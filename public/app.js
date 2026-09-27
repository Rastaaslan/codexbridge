const $ = (s) => document.querySelector(s);
let token = "",
  selected = null,
  jobs = [],
  eventsAbort = null,
  eventCursor = 0,
  refreshBusy = false;
let submission = null;
const el = (tag, text, cls) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
function notice(text) {
  $("#notice").textContent = text;
  $("#notice").style.display = "block";
  setTimeout(() => ($("#notice").style.display = "none"), 6500);
}
async function tool(name, args = {}) {
  const r = await fetch("/api/tools/" + name, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error || "Service indisponible");
  return data;
}
async function refresh() {
  if (!token || refreshBusy) return;
  refreshBusy = true;
  try {
    const result = await tool("list_jobs", { limit: 100 });
    jobs = result.jobs;
    $("#count").textContent = result.total;
    const active = [
      "QUEUED",
      "PREPARING",
      "CODEX_RUNNING",
      "REVIEWING",
      "CHANGES_REQUESTED",
    ];
    $("#active-count").textContent = jobs.filter((j) =>
      active.includes(j.status),
    ).length;
    $("#waiting-count").textContent = jobs.filter(
      (j) => j.status === "WAITING_FOR_HUMAN",
    ).length;
    $("#ready-count").textContent = jobs.filter(
      (j) => j.status === "READY_FOR_HUMAN_TEST",
    ).length;
    $("#empty").hidden = jobs.length > 0;
    $("#jobs").replaceChildren();
    for (const job of jobs) {
      const b = el("button", undefined, "job");
      b.append(el("span", job.id, "id"));
      const title = el("div");
      title.append(el("b", job.title), el("small", job.repository));
      b.append(
        title,
        el("span", job.status, "badge " + job.status),
        el("small", `${job.iteration}/${job.maxIterations} passages`),
      );
      b.onclick = () => showJob(job.id);
      $("#jobs").append(b);
    }
    $("#connection").textContent =
      "À jour · " + new Date().toLocaleTimeString();
    if (selected) {
      const j = jobs.find((j) => j.id === selected);
      if (j && $("#detail").dataset.status !== j.status)
        await showJob(selected, false);
    }
  } catch (e) {
    $("#connection").textContent = "Connexion interrompue";
    notice(e.message);
  } finally {
    refreshBusy = false;
  }
}
$("#login-form").onsubmit = async (e) => {
  e.preventDefault();
  token = $("#token").value.trim();
  try {
    await tool("list_jobs");
    $("#token").value = "";
    $("#login").hidden = true;
    $("#workspace").hidden = false;
    await refresh();
  } catch (e) {
    token = "";
    notice(e.message);
  }
};
$("#logout").onclick = () => {
  token = "";
  eventsAbort?.abort();
  $("#workspace").hidden = true;
  $("#login").hidden = false;
};
const openCreate = () => {
  if (!token) {
    notice("Déverrouillez d’abord votre atelier.");
    return;
  }
  $("#create-dialog").showModal();
};
$("#new-job").onclick = openCreate;
$("#empty-new").onclick = openCreate;
$("#close-dialog").onclick = () => $("#create-dialog").close();
$("#all").onclick = () => {
  $("#detail").hidden = true;
  selected = null;
  eventsAbort?.abort();
};
$("#create-form").onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target),
    button = e.target.querySelector(".primary");
  button.disabled = true;
  try {
    const draft = {
      title: f.get("title"),
      repository: f.get("repository"),
      ticket: f.get("ticket"),
      acceptanceCriteria: String(f.get("criteria"))
        .split("\n")
        .filter((s) => s.trim()),
      options: {
        maxIterations: Number(f.get("iterations")),
      },
    };
    const signature = JSON.stringify(draft);
    if (submission?.signature !== signature)
      submission = { signature, key: crypto.randomUUID() };
    draft.options.idempotencyKey = submission.key;
    const { job } = await tool("create_job", draft);
    submission = null;
    $("#create-dialog").close();
    e.target.reset();
    notice(job.id + " créé et lancé.");
    await refresh();
    await showJob(job.id);
  } catch (e) {
    notice(e.message);
  } finally {
    button.disabled = false;
  }
};
function section(root, title, value, open = false) {
  const d = el("details");
  d.open = open;
  d.append(
    el("summary", title),
    el(
      "pre",
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
    ),
  );
  root.append(d);
}
async function showJob(id, scroll = true) {
  try {
    const report = await tool("get_job_report", { id });
    if (selected !== id) eventCursor = 0;
    selected = id;
    const j = report.job,
      d = $("#detail");
    d.hidden = false;
    d.dataset.status = j.status;
    d.replaceChildren();
    const head = el("div", undefined, "section-heading");
    head.append(
      el("h2", `${j.id} · ${j.title}`),
      el("span", j.status, "badge " + j.status),
    );
    d.append(head);
    const meta = el("div", undefined, "meta");
    for (const text of [
      j.repository,
      j.branch || "Branche en préparation",
      `Passage ${j.iteration}/${j.maxIterations}`,
      j.codexThreadId ? "Thread " + j.codexThreadId : "Thread en préparation",
    ])
      meta.append(el("span", text));
    d.append(meta);
    if (j.blocker) d.append(el("p", j.blocker, "blocker"));
    const actions = el("div", undefined, "actions");
    for (const [label, name] of [
      ["Annuler", "cancel_job"],
      ["Réessayer", "retry_job"],
      ["Instruction", "send_instruction"],
      ["Valider les tests", "approve_job"],
      ["Demander une correction", "reject_job"],
    ]) {
      const b = el("button", label);
      const resumable = [
        "FAILED",
        "CANCELLED",
        "WAITING_FOR_HUMAN",
        "READY_FOR_HUMAN_TEST",
      ].includes(j.status);
      b.disabled =
        name === "approve_job"
          ? j.status !== "READY_FOR_HUMAN_TEST"
          : name === "cancel_job"
            ? ["COMPLETED", "CANCELLED", "ACCEPTED"].includes(j.status)
            : !resumable;
      b.onclick = async () => {
        let instruction = "";
        if (["send_instruction", "reject_job"].includes(name)) {
          instruction =
            prompt(
              "Instruction ou décision à transmettre au même thread Codex :",
            ) || "";
          if (!instruction) return;
        }
        if (
          ["cancel_job", "approve_job", "reject_job"].includes(name) &&
          !confirm(`${label} pour ${id} ?`)
        )
          return;
        b.disabled = true;
        try {
          await tool(name, { id, instruction });
          await refresh();
          await showJob(id, false);
        } catch (e) {
          notice(e.message);
        } finally {
          b.disabled = false;
        }
      };
      actions.append(b);
    }
    const copy = el("button", "Copier le rapport");
    copy.onclick = () =>
      navigator.clipboard
        .writeText(JSON.stringify(report, null, 2))
        .then(() => notice("Rapport copié."))
        .catch((e) => notice(e.message));
    actions.append(copy);
    const repo = el("button", "Ouvrir le worktree");
    repo.onclick = async () => {
      try {
        const response = await fetch("/api/open-repository/" + id, {
          method: "POST",
          headers: { Authorization: "Bearer " + token },
        });
        const result = await response.json();
        if (!response.ok) throw Error(result.error);
        notice("Dossier ouvert : " + result.opened);
      } catch (e) {
        notice(e.message);
      }
    };
    actions.append(repo);
    d.append(actions);
    section(
      d,
      "Ticket & critères",
      j.ticket + "\n\n" + j.acceptanceCriteria.join("\n"),
    );
    section(
      d,
      "Résultat & tests",
      j.result
        ? j.result.summary +
            "\n\nTests " +
            (j.result.testsPassed ? "réussis" : "à vérifier") +
            " :\n" +
            j.result.testsExecuted.join("\n") +
            (j.result.remainingIssues.length
              ? "\n\nPoints restants :\n" + j.result.remainingIssues.join("\n")
              : "")
        : "Codex travaille encore.",
      true,
    );
    section(
      d,
      "Fichiers modifiés",
      report.changes.changedFiles?.join("\n") ||
        report.changes.error ||
        "Aucune modification.",
    );
    section(d, "Diff Git", report.changes.diff || "Aucun diff disponible.");
    section(
      d,
      "Commits",
      report.changes.commits ||
        "Modifications conservées dans le worktree, sans commit.",
    );
    section(
      d,
      "Historique des reviews",
      report.reviews
        .map(
          (r) =>
            `Passage ${r.iteration} · ${r.decision}\n${r.summary}\n${r.requestedChanges.join("\n")}`,
        )
        .join("\n\n") || "Review en attente.",
    );
    section(
      d,
      "Décisions humaines",
      report.humanDecisions
        .map((h) => `${h.time} · ${h.action}\n${h.instruction}`)
        .join("\n\n") || "Aucune décision demandée.",
    );
    section(d, "Validation fonctionnelle", report.humanTestingInstructions);
    d.append(el("h2", "Activité en direct"));
    const activity = el("div", undefined, "activity");
    activity.id = "activity";
    d.append(activity);
    eventCursor = 0;
    startEvents(id);
    if (scroll) d.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    notice(e.message);
  }
}
async function startEvents(id) {
  eventsAbort?.abort();
  const controller = new AbortController();
  eventsAbort = controller;
  try {
    const r = await fetch(`/api/events/${id}?after=${eventCursor}`, {
      headers: { Authorization: "Bearer " + token },
      signal: controller.signal,
    });
    if (!r.ok) throw Error("Flux d’activité indisponible");
    const reader = r.body.getReader(),
      decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let pos;
      while ((pos = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, pos);
        buffer = buffer.slice(pos + 2);
        const data = block.split("\n").find((l) => l.startsWith("data: "));
        if (!data) continue;
        const event = JSON.parse(data.slice(6));
        eventCursor = event.id;
        const target = $("#activity");
        if (!target) continue;
        const streaming = ["CODEX_MESSAGE", "CODEX_OUTPUT"].includes(
          event.type,
        );
        const last = target.lastElementChild;
        if (streaming && last?.dataset.type === event.type) {
          last.lastElementChild.textContent += event.data.delta || "";
          target.scrollTop = target.scrollHeight;
          continue;
        }
        const row = el("div", undefined, "event");
        row.dataset.type = event.type;
        row.append(
          el("time", new Date(event.time).toLocaleTimeString() + "  "),
          el(
            "b",
            (event.type === "CODEX_MESSAGE"
              ? "Codex"
              : event.type === "CODEX_OUTPUT"
                ? "Sortie de commande"
                : event.type) + "\n",
          ),
          el(
            "span",
            streaming
              ? event.data.delta
              : event.type === "CODEX_ITEM"
                ? event.data.text ||
                  event.data.command ||
                  JSON.stringify(event.data)
                : JSON.stringify(event.data),
          ),
        );
        target.append(row);
        while (target.children.length > 200) target.firstChild.remove();
        target.scrollTop = target.scrollHeight;
      }
    }
  } catch (e) {
    if (!controller.signal.aborted) {
      notice(e.message);
      setTimeout(() => {
        if (selected === id && token) startEvents(id);
      }, 3000);
    }
  }
}
setInterval(refresh, 4000);
