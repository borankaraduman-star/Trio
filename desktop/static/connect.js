"use strict";
(function () {
  const api = window.trioConnect;
  const form = document.getElementById("form");
  const input = document.getElementById("url");
  const button = document.getElementById("submit");
  const message = document.getElementById("message");

  function show(text, kind) {
    message.textContent = text || "";
    message.className = "message" + (kind ? " " + kind : "");
  }

  if (!api) {
    show("Bu sayfa yalnızca Trio uygulamasının içinde çalışır.", "error");
    button.disabled = true;
    return;
  }

  api.state().then(function (state) {
    if (!state) return;
    if (state.current && !input.value) input.value = state.current;
    if (state.notice) show(state.notice, "error");
    // CONTRACT-V11-ADDRESS §8: the address the server announced before it changed.
    if (typeof state.next === "string" && api.useNext) {
      const next = document.getElementById("next");
      const nextButton = document.getElementById("next-go");
      nextButton.textContent = state.next.replace(/^https?:\/\//, "") + " adresine geç";
      next.hidden = false;
      nextButton.addEventListener("click", function () {
        nextButton.disabled = true;
        show("Yeni adres kontrol ediliyor…", "info");
        api.useNext().then(function (result) {
          if (result && result.ok) return show("Bağlanılıyor…", "info");
          show((result && result.message) || "Olmadı.", "error");
          nextButton.disabled = false;
        });
      });
    }
    // CONTRACT-V6-VOICE: the app's own version.
    if (typeof state.version === "string") document.getElementById("version").textContent = "Trio " + state.version;
    input.select();
  });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    button.disabled = true;
    input.disabled = true;
    show("Sunucu kontrol ediliyor…", "info");
    api.submit(input.value).then(function (result) {
      if (result && result.ok) {
        show("Bağlanılıyor…", "info");
        return;
      }
      show((result && result.message) || "Bağlanılamadı.", "error");
      button.disabled = false;
      input.disabled = false;
      input.focus();
    }, function () {
      show("Beklenmeyen bir hata oldu.", "error");
      button.disabled = false;
      input.disabled = false;
    });
  });
})();
