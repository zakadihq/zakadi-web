/* global document, navigator, location */
// spec/06-web-sdk.md 6.3: the message for browsers without ES modules, which run this
// file from <script nomodule src=".../unsupported.js"> next to the SDK's module script.
// ES5 only: no ES2015 syntax, no dependencies. French when the page or the browser
// language is French, else English. It renders into the first <zakadi-call> element,
// else at the end of the body.
(function () {
  "use strict";

  var lang =
    document.documentElement.lang ||
    navigator.language ||
    navigator.userLanguage ||
    "";
  var text = /^fr(-|$)/i.test(lang)
    ? {
        message:
          "Ce navigateur ne peut pas effectuer la v\u00e9rification " +
          "vid\u00e9o. Ouvrez ce lien dans Chrome (Android) ou Safari " +
          "(iPhone) pour continuer.",
        open: "Ouvrir dans Chrome",
        copy: "Copier le lien",
        copied: "Lien copi\u00e9",
      }
    : {
        message:
          "This browser can't run the video check. Open this link in " +
          "Chrome (Android) or Safari (iPhone) to continue.",
        open: "Open in Chrome",
        copy: "Copy link",
        copied: "Link copied",
      };

  function element(tag, content) {
    var node = document.createElement(tag);
    if (content) node.appendChild(document.createTextNode(content));
    return node;
  }

  function show() {
    var url = location.href;
    var box = element("div");
    box.className = "zakadi-unsupported";
    box.setAttribute("role", "alert");
    box.appendChild(element("p", text.message));

    // Chrome opens an intent URL only from a user gesture: a tap on this link.
    if (/Android/.test(navigator.userAgent)) {
      var open = element("a", text.open);
      open.href =
        "intent://" +
        location.host +
        location.pathname +
        location.search +
        "#Intent;scheme=https;package=com.android.chrome;" +
        "S.browser_fallback_url=" +
        encodeURIComponent(url) +
        ";end";
      box.appendChild(open);
    }

    // The link stays visible and selected, so it can be copied by hand where the
    // browser has no copy command.
    var field = element("input");
    field.readOnly = true;
    field.value = url;
    var copy = element("button", text.copy);
    copy.type = "button";
    copy.onclick = function () {
      field.select();
      if (document.execCommand("copy")) {
        copy.firstChild.nodeValue = text.copied;
      }
    };
    box.appendChild(field);
    box.appendChild(copy);

    var host = document.getElementsByTagName("zakadi-call")[0];
    (host || document.body).appendChild(box);
  }

  if (document.body) {
    show();
  } else {
    document.addEventListener("DOMContentLoaded", show);
  }
})();
