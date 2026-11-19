"use strict";
(function () {
  const api = window.trioGame;
  const $ = (id) => document.getElementById(id);
  if (!api) {
    $("status").textContent = "Bu sayfa yalnızca Trio uygulamasının içinde çalışır.";
    return;
  }

  function ago(ms, now) {
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 90) return s + " sn önce";
    const m = Math.round(s / 60);
    if (m < 90) return m + " dk önce";
    return Math.round(m / 60) + " sa önce";
  }

  function duration(since, now) {
    const m = Math.max(0, Math.floor((now / 1000 - since) / 60));
    if (m < 1) return "az önce başladı";
    if (m < 60) return m + " dk";
    return Math.floor(m / 60) + " sa " + (m % 60) + " dk";
  }

  function statusText(status, now) {
    if (!status) return "Oyunda değil";
    let text = status.game;
    if (status.detail) {
      text += " · " + status.detail.level;
      const place = status.detail.zone || status.detail.subzone;
      if (place) text += " · " + place;
      text += " (" + status.detail.character + (status.detail.source === "saved" ? ", çıkışta kaydedilen" : "") + ")";
    }
    return text + " · " + duration(status.since, now);
  }

  function row(dl, term, value) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dl.append(dt, dd);
  }

  function renderFlavours(list) {
    const ul = $("flavours");
    ul.replaceChildren();
    for (const f of list || []) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn secondary";
      b.textContent = "Bunu kullan";
      b.addEventListener("click", () => api.useFolder(f.path).then(refresh));
      const label = document.createElement("span");
      label.className = "mono";
      const bits = [f.hasLogs ? "Logs" : null, f.hasWtf ? "WTF" : null, f.hasAddOns ? "AddOns" : null].filter(Boolean);
      label.textContent = f.path + "  (" + (bits.join(", ") || "boş") + ")";
      li.append(label, b);
      ul.append(li);
    }
  }

  function render(state) {
    if (!state) return;
    const d = state.diagnostics;
    const now = state.now;
    $("status").textContent = statusText(d.status, now);
    $("listening").textContent = state.pageListening
      ? "Trio sayfası dinliyor: durum arkadaşlarına gidiyor."
      : "Trio sayfası şu an dinlemiyor (paylaşım kapalı ya da sunucu sayfası açık değil).";
    $("folder").textContent = state.folder || "(seçilmedi)";
    const dl = $("diag");
    dl.replaceChildren();
    row(dl, "Sohbet kaydı", d.folder
      ? (d.log.state === "ok"
        ? "var · " + d.log.size + " bayt · son değişiklik " + (d.log.mtimeMs ? ago(d.log.mtimeMs, now) : "?")
        : d.log.state === "missing" ? "Logs/WoWChatLog.txt yok (oyunda /chatlog açık mı?)" : "okunamıyor (" + (d.log.error || "?") + ")")
      : "klasör seçilmedi");
    row(dl, "Son TRIO1 satırı", d.lastFrame
      ? d.lastFrame.line + " · " + ago(d.lastFrame.seenAt, now) + " · " + (d.lastFrame.source === "log" ? "sohbet kaydından" : "SavedVariables'tan")
      : "henüz görülmedi");
    row(dl, "SavedVariables", d.saved.found ? "bulundu · son yazılma " + ago(d.saved.mtimeMs, now) : "bulunamadı (oyundan bir kez çıkış ya da /reload sonrası oluşur)");
    row(dl, "İşlem listesi", d.processes.readable === null ? "henüz okunmadı" : d.processes.readable
      ? "okunuyor · tanınan: " + (d.processes.matched.length ? d.processes.matched.join(", ") : "yok")
      : "okunamıyor");
    const custom = $("custom");
    custom.replaceChildren();
    for (const g of state.customGames) {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.textContent = g.name + " — " + g.executable;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn secondary";
      b.textContent = "Kaldır";
      b.addEventListener("click", () => api.removeGame(g.executable).then(refresh));
      li.append(span, b);
      custom.append(li);
    }
  }

  let flavoursShown = false;
  function refresh() {
    return api.state().then((state) => {
      render(state);
      if (state && !flavoursShown && state.flavours && state.flavours.length > 1) renderFlavours(state.flavours);
    });
  }

  $("choose").addEventListener("click", () => {
    api.chooseFolder().then((result) => {
      flavoursShown = true;
      renderFlavours(result && result.flavours && result.flavours.length > 1 ? result.flavours : []);
      if (result && result.flavours && result.flavours.length === 0) $("folder").textContent = "Bu klasörde Logs/WTF bulunamadı.";
      refresh();
    });
  });

  $("detect").addEventListener("click", () => {
    api.autodetect().then((list) => {
      flavoursShown = true;
      renderFlavours(list);
      if (!list || list.length === 0) $("folder").textContent = "Bilinen yerlerde bulunamadı; “Klasör seç…” ile göster.";
    });
  });

  $("copy").addEventListener("click", () => {
    api.copy().then((ok) => {
      $("copied").textContent = ok ? "Kopyalandı." : "Kopyalanamadı.";
    });
  });

  $("loadRunning").addEventListener("click", () => {
    api.running().then((names) => {
      const select = $("exe");
      select.replaceChildren();
      for (const n of names || []) {
        const o = document.createElement("option");
        o.value = n;
        o.textContent = n;
        select.append(o);
      }
      $("addForm").hidden = false;
    });
  });

  $("add").addEventListener("click", () => {
    const exe = $("exe").value;
    const name = $("gameName").value;
    api.addGame(exe, name).then((ok) => {
      $("addMessage").textContent = ok ? "Eklendi." : "Bir program seç ve 1–64 karakterlik bir ad yaz.";
      if (ok) $("gameName").value = "";
      refresh();
    });
  });

  refresh();
  setInterval(refresh, 2000);
})();
