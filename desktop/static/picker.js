"use strict";
(function () {
  const api = window.trioPicker;
  const grid = document.getElementById("grid");
  const share = document.getElementById("share");
  const cancel = document.getElementById("cancel");
  const refresh = document.getElementById("refresh");
  const audioRow = document.getElementById("audio-row");
  const audio = document.getElementById("audio");
  const tabs = Array.prototype.slice.call(document.querySelectorAll(".tab"));
  let kind = "screen";
  let sources = [];
  let selected = null;

  function el(tag, cls) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  }

  function render() {
    grid.textContent = "";
    const visible = sources.filter(function (s) { return s.kind === kind; });
    if (visible.length === 0) {
      const empty = el("div", "empty");
      empty.textContent = kind === "screen" ? "Ekran bulunamadı." : "Paylaşılabilecek pencere yok.";
      grid.appendChild(empty);
    }
    visible.forEach(function (s) {
      const card = el("button", "source");
      card.type = "button";
      card.setAttribute("aria-pressed", String(selected === s.id));
      card.title = s.name;
      const thumb = el("div", "thumb");
      if (s.thumbnail) {
        const img = el("img");
        img.src = s.thumbnail;
        img.alt = "";
        thumb.appendChild(img);
      }
      const name = el("div", "name");
      if (s.icon) {
        const icon = el("img");
        icon.src = s.icon;
        icon.alt = "";
        name.appendChild(icon);
      }
      const label = el("span");
      label.textContent = s.name; // text, never HTML
      name.appendChild(label);
      card.appendChild(thumb);
      card.appendChild(name);
      card.addEventListener("click", function () { selected = s.id; share.disabled = false; render(); });
      card.addEventListener("dblclick", function () { selected = s.id; choose(); });
      grid.appendChild(card);
    });
  }

  function load() {
    api.sources().then(function (result) {
      if (!result) return;
      sources = Array.isArray(result.sources) ? result.sources : [];
      audioRow.hidden = !result.audio;
      if (selected && !sources.some(function (s) { return s.id === selected; })) {
        selected = null;
        share.disabled = true;
      }
      if (!sources.some(function (s) { return s.kind === kind; }) && sources.length > 0) {
        setKind(sources[0].kind);
      } else {
        render();
      }
    });
  }

  function setKind(next) {
    kind = next;
    tabs.forEach(function (t) { t.setAttribute("aria-selected", String(t.dataset.kind === kind)); });
    render();
  }

  function choose() {
    if (!selected) return;
    api.choose(selected, !audioRow.hidden && audio.checked);
  }

  tabs.forEach(function (t) { t.addEventListener("click", function () { setKind(t.dataset.kind); }); });
  share.addEventListener("click", choose);
  cancel.addEventListener("click", function () { api.cancel(); });
  refresh.addEventListener("click", load);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") api.cancel();
    if (e.key === "Enter" && selected && document.activeElement === document.body) choose();
  });
  load();
})();
