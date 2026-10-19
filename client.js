/*!
 * dsh-video-preview — client half (browser bundle).
 *
 * Registers a file viewer with dsh-better-sidebar via `ctx.betterSidebar`
 * so video files open in the sidebar editor as an inline <video> player.
 *
 * Bundle format: the official DSH client-bundle shape — a lazy-CJS closure
 * registered with window.__ModuleLoader__.load({ id, factory }). `react` is
 * an external resolved from the shell's module table at runtime; everything
 * else is inlined. The viewer streams from the plugin's own /video host route
 * (HTTP Range → seeking works), falling back to the built-in download route.
 */
window.__ModuleLoader__.load({
  id: "dsh-video-preview",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    "use strict";

    // src/client/index.js
    var import_react = require("react");

    /** Host route that reports the user's home directory (index.js). */
    var HOME_URL = "/video/home";

    /** Cached promise of the home lookup; reset to null when it comes back empty. */
    var homePromise = null;

    /** Resolve the host user's home directory once. */
    function homeDir() {
      if (homePromise !== null) return homePromise;
      homePromise = fetch(HOME_URL, { headers: { accept: "application/json" } })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (body) {
          return body !== null && typeof body.home === "string" && body.home !== "" ? body.home : null;
        })
        .catch(function () { return null; })
        .then(function (home) {
          if (home === null) homePromise = null;
          return home;
        });
      return homePromise;
    }

    /** `~`, `~/x`, `~\x` expanded against `home`; null for any other path. */
    function expandHomePath(home, path) {
      if (home === null) return null;
      if (path === "~") return home;
      if (path.indexOf("~/") === 0 || path.indexOf("~\\") === 0) return home + path.slice(1);
      return null;
    }

    /**
     * Rewrite a `~`-prefixed `path` in better-sidebar's /sidebar/api bodies
     * into an absolute one before the request leaves the browser.
     *
     * better-sidebar only expands `~` after its own relative-path resolution:
     * `fs.read` joins every non-absolute target onto the session cwd first, so
     * a typed `~/.dsh/skins/harbor/patches.css` is stat'd as
     * `<cwd>/~/.dsh/...` and fails with ENOENT. Expanding here keeps the
     * editor's other entry points (tree rows, git rows) byte-for-byte
     * unchanged: only requests that already carry a `~` target are touched,
     * and only when the host answers the home lookup.
     */
    function applyPathShim() {
      var original = window.fetch;
      window.fetch = function (input, init) {
        var url = typeof input === "string" ? input : input && typeof input.url === "string" ? input.url : "";
        var body = init && typeof init.body === "string" ? init.body : null;
        if (url.indexOf("/sidebar/api/") !== -1 && body !== null && body.indexOf("\"path\":\"~") !== -1) {
          try {
            var payload = JSON.parse(body);
            var path = payload !== null && typeof payload.path === "string" ? payload.path : null;
            var prefixed = path !== null && (path === "~" || path.indexOf("~/") === 0 || path.indexOf("~\\") === 0);
            if (prefixed) {
              return homeDir().then(function (home) {
                var expanded = expandHomePath(home, path);
                if (expanded === null) return original.call(window, input, init);
                payload.path = expanded;
                return original.call(window, input, Object.assign({}, init, { body: JSON.stringify(payload) }));
              });
            }
          } catch (error) {
            // Not the JSON body we expect: send the request through untouched.
          }
        }
        return original.call(window, input, init);
      };
      window.fetch.__dshVideoPreviewPathShim = true;
      return function () { window.fetch = original; };
    }

    /** File extensions this viewer claims (lowercase, no dot). */
    var VIDEO_EXTS = [
      "mp4", "webm", "mov", "qt", "m4v", "mkv", "avi", "wmv", "flv",
      "ogv", "ogg", "mpeg", "mpg", "3gp", "3g2", "m2ts"
    ];

    /** Absolute URL of the plugin's range-capable video route. */
    function videoUrl(scope, path) {
      var params = new URLSearchParams({ sessionId: scope.sessionId, path: path });
      if (scope.cwd !== undefined && scope.cwd !== "") params.set("cwd", scope.cwd);
      return "/video?" + params.toString();
    }

    /** Absolute URL of the built-in download route (fallback for formats the
     *  browser cannot decode — the <video> onError path still lets the user
     *  grab the raw file). */
    function downloadUrl(scope, path) {
      var params = new URLSearchParams({ sessionId: scope.sessionId, path: path });
      if (scope.cwd !== undefined && scope.cwd !== "") params.set("cwd", scope.cwd);
      params.set("download", "1");
      return "/sidebar/file?" + params.toString();
    }

    /**
     * Settings-inventory glyph in the app's outline style (16px, 1.5px
     * stroke, currentColor): a video screen with a filled play triangle.
     */
    function IconVideoOutline16(size) {
      return import_react.createElement("svg", {
        width: size,
        height: size,
        viewBox: "0 0 16 16",
        fill: "none",
        xmlns: "http://www.w3.org/2000/svg"
      }, [
        import_react.createElement("rect", {
          key: "frame",
          x: 1.5,
          y: 3,
          width: 13,
          height: 10,
          rx: 2,
          stroke: "currentColor",
          strokeWidth: 1.5
        }),
        import_react.createElement("path", {
          key: "play",
          d: "m6 5.75 4.25 2.25L6 10.25z",
          fill: "currentColor",
          stroke: "none"
        })
      ]);
    }

    /** ffmpeg command that re-encodes a file the browser cannot decode. */
    function transcodeCommand(path) {
      var quote = function (value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; };
      var stem = path.replace(/\.[^./\\]+$/, "");
      return "ffmpeg -i " + quote(path) + " -c:v libx264 -crf 20 -pix_fmt yuv420p -movflags +faststart " + quote(stem + "_h264.mp4");
    }

    /** ReactNode: the inline player. Props = FileViewerProps. */
    function VideoView(props) {
      var scope = props.scope;
      var path = props.path;
      var url = videoUrl(scope, path);
      var dl = downloadUrl(scope, path);
      var failedPair = import_react.useState(false);
      var failed = failedPair[0];
      var setFailed = failedPair[1];
      var copiedPair = import_react.useState(false);
      var copied = copiedPair[0];
      var setCopied = copiedPair[1];
      var videoRef = import_react.useRef(null);
      var timerRef = import_react.useRef(null);
      // Better-sidebar hands a session-relative path; the command must work
      // from any directory, so rebuild the absolute one when the cwd is known.
      var absolute = /^[\/]|^[A-Za-z]:[\\/]/.test(path) || scope.cwd === undefined
        ? path
        : scope.cwd.replace(/[\\/]+$/, "") + "/" + path;
      var command = transcodeCommand(absolute);

      // `error` on a media element does not bubble, so React's synthetic
      // onError is not enough here: listen on the element itself.
      import_react.useEffect(function () {
        setFailed(false);
        var element = videoRef.current;
        if (element === null) return undefined;
        var onError = function () { setFailed(true); };
        element.addEventListener("error", onError);
        if (element.error !== null) onError();
        return function () { element.removeEventListener("error", onError); };
      }, [url]);

      import_react.useEffect(function () {
        return function () {
          if (timerRef.current !== null) clearTimeout(timerRef.current);
        };
      }, []);

      var copyCommand = function () {
        var flash = function () {
          setCopied(true);
          if (timerRef.current !== null) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(function () { setCopied(false); }, 2000);
        };
        if (navigator.clipboard !== undefined && navigator.clipboard.writeText !== undefined) {
          navigator.clipboard.writeText(command).then(flash, flash);
          return;
        }
        var area = document.createElement("textarea");
        area.value = command;
        area.style.cssText = "position:fixed;left:-9999px;top:0";
        document.body.appendChild(area);
        area.select();
        try { document.execCommand("copy"); } catch (error) { /* the text stays selectable on screen */ }
        area.remove();
        flash();
      };

      var body = failed
        ? import_react.createElement("div", {
          key: "unsupported",
          style: {
            flex: "1 1 auto",
            minHeight: 0,
            overflow: "auto",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            padding: "14px",
            borderRadius: "6px",
            background: "var(--dsw-alias-bg-layer-2, #1d2540)",
            border: "1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.07))"
          }
        }, [
          import_react.createElement("div", {
            key: "title",
            style: { fontSize: "13px", fontWeight: 600, color: "var(--dsw-alias-label-primary, #fff5ec)" }
          }, "\u6D4F\u89C8\u5668\u89E3\u4E0D\u4E86\u8FD9\u4E2A\u89C6\u9891\u7684\u7F16\u7801"),
          import_react.createElement("div", {
            key: "desc",
            style: { fontSize: "12px", lineHeight: "1.6", color: "var(--dsw-alias-label-secondary, #d6c7b8)" }
          }, "\u5E38\u89C1\u539F\u56E0\u662F\u7F16\u7801\u4E0D\u53D7\u652F\u6301\uFF08\u5982 OpenCV \u9ED8\u8BA4\u5199\u51FA\u7684 mp4v / MPEG-4 Part 2\uFF0C\u6216 HEVC\uFF09\u3002\u5728\u4F1A\u8BDD\u5DE5\u4F5C\u76EE\u5F55\u4E0B\u8DD1\u4E0B\u9762\u8FD9\u6761\u547D\u4EE4\uFF0C\u8F6C\u6210 h264 \u5C31\u80FD\u64AD\uFF1A"),
          import_react.createElement("pre", {
            key: "cmd",
            style: {
              margin: 0,
              padding: "8px 10px",
              borderRadius: "4px",
              background: "var(--dsw-alias-markdown-code-block, #12182e)",
              color: "var(--dsw-alias-label-primary, #fff5ec)",
              fontSize: "11px",
              lineHeight: "1.55",
              fontFamily: "var(--dsw-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              userSelect: "all"
            }
          }, command),
          import_react.createElement("div", {
            key: "actions",
            style: { display: "flex", gap: "8px", alignItems: "center" }
          }, [
            import_react.createElement("button", {
              key: "copy",
              type: "button",
              onClick: copyCommand,
              style: {
                border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.12))",
                borderRadius: "4px",
                background: copied ? "var(--dsw-alias-state-success-tertiary, rgba(127,214,164,0.16))" : "var(--dsw-alias-bg-layer-3, #222b4a)",
                color: copied ? "var(--dsw-alias-state-success-primary, #7fd6a4)" : "var(--dsw-alias-label-primary, #fff5ec)",
                fontSize: "12px",
                padding: "4px 10px",
                cursor: "pointer"
              }
            }, copied ? "\u5DF2\u590D\u5236" : "\u590D\u5236\u547D\u4EE4"),
            import_react.createElement("span", {
              key: "hint",
              style: { fontSize: "11px", color: "var(--dsw-alias-label-caption, #8a8291)" }
            }, "\u4E5F\u53EF\u4EE5\u76F4\u63A5\u4E0B\u8F7D\u539F\u6587\u4EF6\uFF08\u53F3\u4E0B\u89D2\uFF09")
          ])
        ])
        : import_react.createElement("video", {
          key: "v",
          ref: videoRef,
          src: url,
          controls: true,
          preload: "metadata",
          playsInline: true,
          style: {
            width: "100%",
            maxHeight: "100%",
            flex: "1 1 auto",
            minHeight: 0,
            background: "#000",
            borderRadius: "6px",
            outline: "none"
          }
        });

      return import_react.createElement("div", {
        style: {
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          padding: "12px",
          minWidth: 0,
          minHeight: 0,
          height: "100%",
          boxSizing: "border-box"
        }
      }, [body, import_react.createElement("div", {
        key: "meta",
        style: {
          display: "flex",
          alignItems: "center",
          gap: "10px",
          flex: "none",
          fontSize: "12px",
          color: "var(--dsw-alias-label-secondary, #8b90a0)",
          minWidth: 0
        }
      }, [
        import_react.createElement("span", {
          key: "t",
          title: path,
          style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "1 1 auto" }
        }, props.title),
        import_react.createElement("a", {
          key: "d",
          href: dl,
          download: true,
          style: {
            flex: "none",
            color: "var(--dsw-alias-link-normal, #4c8dff)",
            textDecoration: "none"
          }
        }, "\u4E0B\u8F7D")
      ])
      ]);
    }

    /** Cordis service dependencies (the better-sidebar registry service). */
    var inject = ["betterSidebar"];

    function apply(ctx) {
      // The fetch shim patches a global; ctx.effect hands back its disposer so
      // teardown (HMR / plugin disable) restores the untouched window.fetch.
      ctx.effect(function () {
        return applyPathShim();
      });

      // Registration must be wrapped in ctx.effect so the disposer returned by
      // registerFileViewer is invoked on fiber teardown (HMR / plugin disable);
      // otherwise a later re-activation throws "already registered".
      ctx.effect(function () {
        return ctx.betterSidebar.registerFileViewer({
          id: "video",
          title: "Video",
          icon: function (size) { return IconVideoOutline16(size); },
          exts: VIDEO_EXTS,
          fetchStrategy: "none",
          component: VideoView
        });
      });
    }

    module.exports = { inject: inject, apply: apply };
    return module.exports;
  }
});
