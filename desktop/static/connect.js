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
