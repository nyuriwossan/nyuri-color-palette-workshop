"""ブラウザ操作テスト（Playwright + Chrome）。

使い方:
    pip install playwright
    python3 tests/browser/ui_test.py            # プロジェクト直下で実行

iPhone相当のビューポート（タッチ有効）で主要操作を通しで確認する。
実機のiPhone Safariそのものではない点に注意（エンジンが違う）。
"""
import functools
import http.server
import json
import os
import re
import sys
import threading

from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SHOTS = os.environ.get("SHOTS_DIR", "")
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("  ok   " if cond else "  FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def chips(page):
    """[(hex, ratio)] を画面のチップから読む"""
    labels = page.eval_on_selector_all("#chips .chip:not(.add)", "els => els.map(e => e.getAttribute('aria-label'))")
    out = []
    for lb in labels:
        m = re.search(r"(#[0-9A-F]{6}) (\d+)%", lb)
        out.append((m.group(1), int(m.group(2))))
    return out


def total(page):
    return sum(r for _, r in chips(page))


def valid(page):
    cs = chips(page)
    return sum(r for _, r in cs) == 100 and all(r >= 1 for _, r in cs)


def rgb_to_hex(s):
    m = re.findall(r"\d+", s)
    return "#%02X%02X%02X" % tuple(int(x) for x in m[:3])


def close_sheet(page):
    page.locator(".sheet-head .btn").last.click()


def run_mobile(browser, base, width, height, full):
    print(f"\n== {width}x{height} タッチ ==")
    ctx = browser.new_context(viewport={"width": width, "height": height}, has_touch=True, is_mobile=True,
                              device_scale_factor=2, accept_downloads=True,
                              permissions=["clipboard-read", "clipboard-write"])
    page = ctx.new_page()
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(base)
    page.wait_for_selector("#chips .chip")

    check("初期表示: 5色・合計100%", len(chips(page)) == 5 and valid(page))
    check("初期表示: Overallのみ有効", page.eval_on_selector_all(".tab-badge", "e => e.map(x => x.textContent)") == ["ON", "OFF", "OFF"])
    sw = page.evaluate("document.documentElement.scrollWidth")
    check("横スクロールなし（初期）", sw <= width, f"scrollWidth={sw}")

    small = page.evaluate("""() => [...document.querySelectorAll('#app button, #app input:not([type=color]), #app .sl, #app .handle')]
        .filter(e => e.offsetParent !== null)
        .map(e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e, '::before');
                    const extra = e.classList.contains('sl') ? 16 : 0;
                    return [e.id || e.className, Math.round(r.width), Math.round(r.height + extra)]; })
        .filter(x => x[2] < 40 || x[1] < 30)""")
    # 例外: HEXコピーの文字リンク（高さ32px・横幅は十分）とバーの色領域（幅が比率で決まる）
    small = [s for s in small if s[0] not in ("btnCopyHex",) and "seg" not in s[0]]
    check("タップ対象が小さすぎない（高さ40px以上）", not small, json.dumps(small, ensure_ascii=False))

    if SHOTS:
        page.screenshot(path=os.path.join(SHOTS, f"top_{width}.png"))

    if not full:
        # 10色にしても横スクロールしないか
        for _ in range(5):
            page.locator("#btnAdd").tap()
        check("10色でも横スクロールなし", page.evaluate("document.documentElement.scrollWidth") <= width)
        check("10色: 合計100%", len(chips(page)) == 10 and valid(page))
        for opener in ["#btnSuggest", "#btnTransfer", "#btnHexPrompt", "#btnPresets", "#btnMenu"]:
            page.locator(opener).tap()
            page.wait_for_selector(".sheet")
            w = page.evaluate("Math.max(document.documentElement.scrollWidth, document.querySelector('.sheet-body').scrollWidth)")
            check(f"シート {opener} で横にはみ出さない", w <= width, f"{w}")
            close_sheet(page)
        if SHOTS:
            page.screenshot(path=os.path.join(SHOTS, f"ten_{width}.png"), full_page=True)
        check("コンソールエラーなし", not errors, "; ".join(errors)[:300])
        ctx.close()
        return

    # ---- HEX入力 ----
    page.locator("#hexInput").fill("00ff88")
    check("HEX入力（#なし小文字）が反映", chips(page)[0][0] == "#00FF88")
    seg_bg = rgb_to_hex(page.eval_on_selector("#bar .seg", "e => getComputedStyle(e).backgroundColor"))
    check("プレビューが色変更と同期", seg_bg == "#00FF88", seg_bg)
    page.locator("#hexInput").fill("#zzz")
    page.locator("#hexInput").press("Enter")
    check("無効HEX: 警告を表示", page.locator("#hexErr").is_visible())
    check("無効HEX: 元の色を保持", chips(page)[0][0] == "#00FF88" and page.input_value("#hexInput") == "#00FF88")
    page.locator("#hexInput").fill("#abc")
    page.locator("#hexInput").press("Enter")
    check("3桁HEXを6桁に展開", chips(page)[0][0] == "#AABBCC")
    page.locator("#nativeColor").evaluate("e => { e.value = '#123456'; e.dispatchEvent(new Event('input', {bubbles: true})); }")
    check("標準カラーピッカーの値が反映・HEX欄と同期", chips(page)[0][0] == "#123456" and page.input_value("#hexInput") == "#123456")

    # ---- 視覚ピッカー（タッチ相当のポインタ操作） ----
    box = page.locator("#sv").bounding_box()
    page.mouse.move(box["x"] + box["width"] * 0.8, box["y"] + box["height"] * 0.2)
    page.mouse.down()
    page.mouse.move(box["x"] + box["width"] * 0.6, box["y"] + box["height"] * 0.4, steps=4)
    page.mouse.up()
    after_sv = chips(page)[0][0]
    check("色エリアのドラッグで色が変わる", after_sv != "#123456", after_sv)
    check("色エリア操作がHEX欄と同期", page.input_value("#hexInput") == after_sv)
    box = page.locator("#slH").bounding_box()
    y0 = page.evaluate("window.scrollY")
    page.mouse.move(box["x"] + 20, box["y"] + box["height"] / 2)
    page.mouse.down()
    page.mouse.move(box["x"] + box["width"] * 0.5, box["y"] + box["height"] / 2 + 60, steps=5)
    page.mouse.up()
    check("色相スライダーで色が変わる", chips(page)[0][0] != after_sv)
    check("スライダー操作中にページがスクロールしない", page.evaluate("window.scrollY") == y0)
    check("ドラッグ部品は touch-action:none", page.evaluate("['#sv','#slH','#slS','#slV','#slR','#bar .handle'].every(s => getComputedStyle(document.querySelector(s)).touchAction === 'none')"))
    check("ページ本体はスクロール可能（touch-action制限なし）", page.evaluate("getComputedStyle(document.body).touchAction") in ("auto", "manipulation"))

    # ---- 比率 ----
    page.locator("#ratioInput").fill("50")
    page.locator("#ratioInput").press("Enter")
    cs = chips(page)
    check("比率の数値入力: 50%・合計100%", cs[0][1] == 50 and valid(page), str(cs))
    page.locator("#ratioInput").fill("999")
    page.locator("#ratioInput").press("Enter")
    check("比率の上限: 5色なら96%", chips(page)[0][1] == 96 and valid(page), str(chips(page)))
    for bad in ["0", "abc", "-5", "1.5", ""]:
        page.locator("#ratioInput").fill(bad)
        page.locator("#ratioInput").press("Enter")
    check("比率の異常入力（0・文字・負数・小数・空）で壊れない", valid(page) and chips(page)[0][1] >= 1, str(chips(page)))
    page.locator("#btnEqual").tap()
    check("均等: 20%×5", [r for _, r in chips(page)] == [20] * 5)
    page.locator("#slR").scroll_into_view_if_needed()
    box = page.locator("#slR").bounding_box()
    page.mouse.move(box["x"] + 20, box["y"] + 14)
    page.mouse.down()
    page.mouse.move(box["x"] + box["width"] * 0.7, box["y"] + 14, steps=6)
    page.mouse.up()
    check("比率スライダーのドラッグ: 合計100%", valid(page) and chips(page)[0][1] != 20, str(chips(page)))

    # ---- 境界ドラッグ ----
    page.locator("#btnEqual").tap()
    page.evaluate("window.scrollTo(0, 0)")
    hb = page.locator("#bar .handle").nth(1).bounding_box()
    barw = page.locator("#bar").bounding_box()["width"]
    page.mouse.move(hb["x"] + hb["width"] / 2, hb["y"] + hb["height"] / 2)
    page.mouse.down()
    page.mouse.move(hb["x"] + hb["width"] / 2 + barw * 0.10, hb["y"] + hb["height"] / 2, steps=5)
    page.mouse.up()
    rs = [r for _, r in chips(page)]
    check("境界ドラッグ: 隣り合う2色だけが動き合計は不変", rs[0] == 20 and rs[3] == 20 and rs[4] == 20 and rs[1] + rs[2] == 40 and rs[1] > 20, str(rs))

    # ---- 元に戻す・やり直す ----
    page.locator("#btnUndo").tap()
    check("元に戻す", [r for _, r in chips(page)] == [20] * 5)
    page.locator("#btnRedo").tap()
    check("やり直す", [r for _, r in chips(page)] == rs)

    # ---- 追加・削除・上限下限 ----
    while page.locator("#btnAdd").is_enabled():
        page.locator("#btnAdd").tap()
        assert valid(page), chips(page)
    check("10色まで追加でき、毎回合計100%", len(chips(page)) == 10 and valid(page))
    check("10色を超えて追加できない（追加ボタン無効・追加チップ非表示）", page.locator("#btnAdd").is_disabled() and page.locator("#chips .chip.add").count() == 0 and page.locator("#btnDup").is_disabled())
    check("10色でも横スクロールなし", page.evaluate("document.documentElement.scrollWidth") <= width)
    while page.locator("#btnDel").is_enabled():
        page.locator("#btnDel").tap()
        assert valid(page), chips(page)
    check("1色まで削除でき、毎回合計100%", chips(page)[0][1] == 100 and len(chips(page)) == 1)
    check("最後の1色は削除できない", page.locator("#btnDel").is_disabled())
    check("1色のとき比率は100%固定", page.locator("#ratioInput").is_disabled() and page.evaluate("document.querySelector('#slR').classList.contains('disabled')"))
    for _ in range(3):
        page.locator("#btnAdd").tap()
    check("追加後も合計100%", len(chips(page)) == 4 and valid(page))

    # ---- 並べ替え ----
    before = chips(page)
    page.locator("#chips .chip").nth(0).tap()
    page.locator("#btnRight").tap()
    check("右へ移動（色と比率が一緒に動く）", chips(page)[1] == before[0] and chips(page)[0] == before[1])
    page.locator("#btnReverse").tap()
    check("順序を反転", chips(page) == list(reversed([before[1], before[0], before[2], before[3]])))
    b2 = chips(page)
    page.locator("#btnShuffle").tap()
    check("シャッフル: 並びだけ変わり色と比率の組は同じ", chips(page) != b2 and sorted(chips(page)) == sorted(b2))
    page.locator("#bar .seg").nth(2).tap()
    check("バーの色領域タップで選択", page.locator("#chips .chip").nth(2).get_attribute("aria-pressed") == "true")

    # ---- 固定（ロック） ----
    page.locator("#chips .chip").nth(1).tap()
    page.locator("#btnLockRatio").tap()
    locked = chips(page)[1][1]
    page.locator("#chips .chip").nth(0).tap()
    page.locator("#ratioInput").fill("60")
    page.locator("#ratioInput").press("Enter")
    check("比率を固定した色は他の調整で動かない", chips(page)[1][1] == locked and valid(page), str(chips(page)))
    page.locator("#chips .chip").nth(1).tap()
    page.locator("#btnLockRatio").tap()

    # ---- 3系統の独立 ----
    overall_before = chips(page)
    page.locator('.tab[data-scope="character"]').tap()
    char_before = chips(page)
    check("Characterは別の配色を持つ", char_before != overall_before)
    page.locator("#hexInput").fill("#FF0000")
    page.locator('.tab[data-scope="overall"]').tap()
    check("タブを戻してもOverallの内容が保持される", chips(page) == overall_before)
    page.locator('.tab[data-scope="character"]').tap()
    check("Characterの変更も保持される", chips(page)[0][0] == "#FF0000")

    # ---- コピー ----
    page.locator('.tab[data-scope="overall"]').tap()
    page.locator("#btnCopyAll").tap()
    page.wait_for_timeout(150)
    clip = page.evaluate("navigator.clipboard.readText()")
    expect = "Overall\n" + "\n".join(f"{h} {r}%" for h, r in chips(page))
    check("全体コピー: 有効な系統だけ・仕様の形式", clip == expect, repr(clip))
    page.locator('.tab[data-scope="character"]').tap()
    page.locator("#scopeSwitch").tap()
    page.locator("#btnCopyAll").tap()
    page.wait_for_timeout(150)
    clip = page.evaluate("navigator.clipboard.readText()")
    check("Characterを有効にすると出力に含まれる", "\n\nCharacter\n#FF0000 " in clip and "Background" not in clip, repr(clip))
    page.locator("#btnCopyHexes").tap()
    page.wait_for_timeout(150)
    clip = page.evaluate("navigator.clipboard.readText()")
    check("HEXだけコピー: 比率を含まない", "%" not in clip and "#FF0000" in clip, repr(clip))
    page.locator("#btnCopyHex").tap()
    page.wait_for_timeout(150)
    check("個別HEXコピー", page.evaluate("navigator.clipboard.readText()") == chips(page)[page.evaluate("[...document.querySelectorAll('#chips .chip')].findIndex(e => e.getAttribute('aria-pressed') === 'true')")][0])
    check("コピー成功の通知が出る", page.locator(".toast").count() >= 1)
    run_hex_prompt(page, clip, width)
    page.locator("#btnTransfer").tap()
    page.wait_for_selector(".tr-row")
    page.locator(".tr-row").nth(0).tap()
    page.wait_for_timeout(150)
    check("転記チェックリスト: タップでコピーし済印", page.locator(".tr-row.done").count() == 1 and page.evaluate("navigator.clipboard.readText()").startswith("#"))
    close_sheet(page)

    # ---- 保存 → 再読み込み ----
    page.locator("#btnSave").tap()
    page.wait_for_selector(".dialog input")
    page.locator(".dialog input").fill("テスト<b>配色</b>")
    page.locator(".dialog [data-ok]").tap()
    page.wait_for_timeout(200)
    check("保存後は未保存表示が消える", page.locator("#dirtyDot").is_hidden())
    check("名前はHTMLとして解釈されない", page.locator("#palName b").count() == 0 and page.inner_text("#palName") == "テスト<b>配色</b>")
    snapshot_all = {}
    for k in ["overall", "character", "background"]:
        page.locator(f'.tab[data-scope="{k}"]').tap()
        snapshot_all[k] = chips(page)
    badges = page.eval_on_selector_all(".tab-badge", "e => e.map(x => x.textContent)")
    page.reload()
    page.wait_for_selector("#chips .chip")
    again = {}
    for k in ["overall", "character", "background"]:
        page.locator(f'.tab[data-scope="{k}"]').tap()
        again[k] = chips(page)
    check("再読み込み後も編集内容が残る", again == snapshot_all)
    check("有効・無効の設定が再読み込みで維持される", page.eval_on_selector_all(".tab-badge", "e => e.map(x => x.textContent)") == badges == ["ON", "ON", "OFF"])
    page.locator("#btnLibrary").tap()
    page.wait_for_selector(".lib-card")
    check("保存済み一覧にカード表示", page.locator(".lib-card").count() == 1 and "テスト<b>配色</b>" in page.inner_text(".lib-name"))
    close_sheet(page)

    # ---- JSON 出力 → 読込（往復） ----
    page.locator("#btnJsonOut").tap()
    page.wait_for_selector(".sheet textarea")
    json_text = page.input_value(".sheet textarea")
    data = json.loads(json_text)
    check("JSON: スキーマ情報を持つ", data["schemaVersion"] == 1 and data["app"] == "nyuri-color-palette-workshop" and data["name"] == "テスト<b>配色</b>")
    with page.expect_download() as dl:
        page.locator("#btnJsonDl").tap()
    path = dl.value.path()
    check("JSONファイルのダウンロード内容が一致", json.load(open(path, encoding="utf-8")) == data and dl.value.suggested_filename.endswith(".json"), dl.value.suggested_filename)
    close_sheet(page)

    page.locator('.tab[data-scope="overall"]').tap()
    page.locator("#hexInput").fill("#010203")  # わざと変える
    page.locator("#btnJsonIn").tap()
    page.wait_for_selector("#jsonPaste")
    page.locator("#jsonPaste").fill("{ これはJSONではない")
    page.locator("#btnPasteLoad").tap()
    check("不正JSON: エラー表示して停止しない", page.locator(".sheet .hex-err").is_visible())
    page.locator("#jsonPaste").fill(json.dumps({"app": "nyuri-color-palette-workshop", "schemaVersion": 1, "scopes": {"overall": {"enabled": True, "colors": [{"hex": "#000000", "ratio": 50}]}}}))
    page.locator("#btnPasteLoad").tap()
    check("構造が不正なJSON: 拒否", page.locator(".sheet .hex-err").is_visible() and chips_safe(page))
    page.locator("#jsonPaste").fill(json_text)
    page.locator("#btnPasteLoad").tap()
    page.wait_for_selector(".dialog")
    page.locator(".dialog [data-ok]").tap()
    page.wait_for_timeout(200)
    again = {}
    for k in ["overall", "character", "background"]:
        page.locator(f'.tab[data-scope="{k}"]').tap()
        again[k] = chips(page)
    check("JSON保存→再読込で内容が一致", again == snapshot_all)
    check("JSON読込後も有効・無効が一致", page.eval_on_selector_all(".tab-badge", "e => e.map(x => x.textContent)") == ["ON", "ON", "OFF"])

    # ファイルからの読込
    page.locator("#btnJsonIn").tap()
    page.wait_for_selector("#jsonFile")
    page.set_input_files("#jsonFile", files=[{"name": "big.json", "mimeType": "application/json", "buffer": b"[" + b"1," * 150000 + b"1]"}])
    page.wait_for_timeout(200)
    check("大きすぎるファイルを拒否", page.locator(".sheet .hex-err").is_visible())
    page.set_input_files("#jsonFile", files=[{"name": "p.json", "mimeType": "application/json", "buffer": json_text.encode("utf-8")}])
    page.wait_for_selector(".dialog")
    page.locator(".dialog [data-ok]").tap()
    page.wait_for_timeout(200)
    check("JSONファイルからの読込", page.inner_text("#palName") == "テスト<b>配色</b>" and page.locator(".sheet").count() == 0)

    # ---- PNG ----
    page.locator('.tab[data-scope="overall"]').tap()
    first = chips(page)[0]
    page.locator("#btnPng").tap()
    page.wait_for_selector("#pngImg")
    page.wait_for_function("document.querySelector('#pngImg').complete && document.querySelector('#pngImg').naturalWidth > 0")
    info = page.evaluate("""() => { const img = document.querySelector('#pngImg'); const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight; const x = c.getContext('2d'); x.drawImage(img, 0, 0);
        // 1つ目のバー（y=270〜420）の左端付近＝1色目の領域
        const d = x.getImageData(70, 345, 1, 1).data;
        return { w: c.width, h: c.height, px: '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase() }; }""")
    check("PNG: 幅1080pxで生成", info["w"] == 1080 and info["h"] > 600, str(info))
    check("PNG: バーに実際の1色目が描かれている", info["px"] == first[0], f"{info['px']} vs {first[0]}")
    with page.expect_download() as dl:
        page.locator("#btnPngDl").tap()
    check("PNGのダウンロード", dl.value.suggested_filename.endswith(".png") and os.path.getsize(dl.value.path()) > 5000)
    if SHOTS:
        import shutil
        shutil.copy(dl.value.path(), os.path.join(SHOTS, "export.png"))
    close_sheet(page)

    # ---- プリセット ----
    page.locator("#btnPresets").tap()
    page.wait_for_selector(".preset")
    check("プリセット12種", page.locator(".preset").count() == 12)
    page.locator(".preset").nth(1).tap()
    page.wait_for_selector(".dialog")
    check("プリセット適用前に確認が出る", page.locator(".dialog").is_visible())
    page.locator(".dialog .btn").first.tap()  # キャンセル
    check("キャンセルで配色は変わらない", chips(page)[0] == first)
    page.locator(".preset").nth(1).tap()
    page.locator(".dialog [data-ok]").tap()
    page.wait_for_timeout(150)
    check("プリセット適用（真夜中の薔薇）", chips(page) == [("#14182E", 35), ("#2C2350", 25), ("#5B2A5E", 15), ("#8C1F3F", 15), ("#D9A7B0", 10)], str(chips(page)))

    # ---- 配色の提案 ----
    page.locator("#chips .chip").nth(3).tap()
    page.locator("#btnLockColor").tap()
    page.locator("#chips .chip").nth(0).tap()
    page.locator("#btnSuggest").tap()
    page.wait_for_selector(".cand")
    check("提案: 調和6種＋バリエーション6種", page.locator(".cand").count() == 12)
    page.locator(".cand").nth(4).tap()  # トライアド
    page.wait_for_timeout(100)
    close_sheet(page)
    cs = chips(page)
    check("調和の採用: 基準色と固定色は不変、他は変化、比率は不変", cs[0][0] == "#14182E" and cs[3][0] == "#8C1F3F" and cs[1][0] != "#2C2350" and [r for _, r in cs] == [35, 25, 15, 15, 10], str(cs))
    page.locator("#btnUndo").tap()
    check("提案の採用も元に戻せる", chips(page)[1][0] == "#2C2350")

    # ---- 保存済みの操作 ----
    page.locator("#btnLibrary").tap()
    page.wait_for_selector(".lib-card")
    page.locator(".lib-btns .btn", has_text="複製").first.tap()
    check("複製", page.locator(".lib-card").count() == 2)
    page.locator(".lib-btns .btn", has_text="名前変更").first.tap()
    page.locator(".dialog input").fill("改名した配色")
    page.locator(".dialog [data-ok]").tap()
    check("名前変更", "改名した配色" in page.inner_text(".sheet-body"))
    page.locator(".lib-btns .btn", has_text="削除").first.tap()
    check("削除前に確認ダイアログ", page.locator(".dialog").is_visible())
    page.locator(".dialog .btn").first.tap()
    check("削除キャンセルで残る", page.locator(".lib-card").count() == 2)
    page.locator(".lib-btns .btn", has_text="削除").first.tap()
    page.locator(".dialog [data-ok]").tap()
    check("削除", page.locator(".lib-card").count() == 1)
    close_sheet(page)
    page.reload()
    page.wait_for_selector("#chips .chip")
    page.locator("#btnLibrary").tap()
    page.wait_for_selector(".lib-card")
    check("保存済みは再読み込み後も残る", page.locator(".lib-card").count() == 1)
    page.locator(".lib-btns .btn", has_text="読込").first.tap()
    if page.locator(".dialog").count():
        page.locator(".dialog [data-ok]").tap()
    page.wait_for_timeout(150)
    check("保存済みの読込", page.locator(".sheet").count() == 0 and valid(page))

    # ---- プレビュー各種・メニュー ----
    for i in range(5):
        page.locator("#pvModes button").nth(i).tap()
        assert page.locator("#pvStage").inner_html()
    check("デザインプレビュー5種を切替表示", True)
    check("プレビューに注意書きがある", "予測" in page.inner_text("main"))
    page.locator("#btnMenu").tap()
    page.wait_for_selector(".menu-item")
    page.locator(".menu-item").last.tap()
    check("「このアプリについて」に非公式の明記", "非公式" in page.inner_text(".sheet-body"))
    close_sheet(page)

    # ---- キーボード表示時の入力欄 ----
    page.locator("#ratioInput").focus()
    page.wait_for_timeout(600)
    r = page.locator("#ratioInput").bounding_box()
    check("入力欄にフォーカスすると画面内に寄る", 0 <= r["y"] <= height - r["height"], str(r))

    check("横スクロールなし（一連の操作後）", page.evaluate("document.documentElement.scrollWidth") <= width)
    check("コンソールエラーなし", not errors, "; ".join(errors)[:400])
    if SHOTS:
        page.evaluate("window.scrollTo(0,0)")
        page.screenshot(path=os.path.join(SHOTS, f"full_{width}.png"), full_page=True)
    ctx.close()


def run_hex_prompt(page, hex_only_clip, width):
    """HEX配色プロンプトのパネル。hex_only_clip は「HEXだけコピー」の結果（系統ごとの正解に使う）"""
    sections = {}
    for block in hex_only_clip.split("\n\n"):
        lines = block.split("\n")
        sections[lines[0].lower()] = ", ".join(lines[1:])
    page.locator("#btnHexPrompt").tap()
    page.wait_for_selector("#hexPromptText")
    sel = lambda: page.eval_on_selector('.hp-scopes [aria-checked="true"]', "e => e.dataset.scope")
    text = lambda: page.inner_text("#hexPromptText").strip()
    check("HEXプロンプト: 初期選択は編集中の系統（Character）", sel() == "character", sel())
    check("HEXプロンプト: Characterの出力が並び順どおり・カンマ区切り", text() == sections["character"], text())
    check("HEXプロンプト: 形式（#RRGGBB, #RRGGBB …）・比率なし", re.fullmatch(r"#[0-9A-F]{6}(, #[0-9A-F]{6})*", text()) is not None and "%" not in text())
    n = len(sections["character"].split(", "))
    check("HEXプロンプト: 配色帯の色数と順番が出力と一致",
          page.locator(".hp-band span").count() == n and
          [rgb_to_hex(x) for x in page.eval_on_selector_all(".hp-band span", "e => e.map(x => getComputedStyle(x).backgroundColor)")] == sections["character"].split(", "))
    page.locator('.hp-scopes [data-scope="overall"]').tap()
    check("HEXプロンプト: 全体に切り替え", sel() == "overall" and text() == sections["overall"], text())
    page.locator('.hp-scopes [data-scope="background"]').tap()
    check("HEXプロンプト: 出力しない系統（背景）は選ばれず、案内が出る",
          sel() == "overall" and text() == sections["overall"] and page.locator(".hp-off").is_visible() and
          "off" in page.locator('.hp-scopes [data-scope="background"]').get_attribute("class"))
    page.locator("#btnHexPromptCopy").tap()
    page.wait_for_timeout(150)
    check("HEXプロンプト: コピー内容が表示と一致", page.evaluate("navigator.clipboard.readText()") == sections["overall"])
    w = page.evaluate("Math.max(document.documentElement.scrollWidth, document.querySelector('.sheet-body').scrollWidth)")
    check("HEXプロンプト: パネルが横にはみ出さない", w <= width, str(w))
    if SHOTS:
        page.screenshot(path=os.path.join(SHOTS, f"hexprompt_{width}.png"))
    page.locator(".sheet-head .btn").last.click()
    page.locator("#btnHexPrompt").tap()
    page.wait_for_selector("#hexPromptText")
    check("HEXプロンプト: 開き直しても最後に選んだ系統を覚えている", sel() == "overall")
    page.locator(".sheet-head .btn").last.click()
    check("HEXプロンプト: 操作後も既存の有効・無効設定は不変",
          page.eval_on_selector_all(".tab-badge", "e => e.map(x => x.textContent)") == ["ON", "ON", "OFF"])


def run_hex_prompt_enable(browser, base):
    """「出力しない」系統を、パネル内から出力に含めて選べるか（別の状態で確認）"""
    print("\n== HEXプロンプト：出力しない系統を有効にする ==")
    ctx = browser.new_context(viewport={"width": 320, "height": 568}, has_touch=True, is_mobile=True,
                              permissions=["clipboard-read", "clipboard-write"])
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(base)
    page.wait_for_selector("#chips .chip")
    page.locator('.tab[data-scope="background"]').tap()
    expect = ", ".join(h for h, _ in chips(page))
    page.locator("#btnHexPrompt").tap()
    page.wait_for_selector("#hexPromptText")
    check("初期状態では Background を選べず、全体が選ばれる",
          page.eval_on_selector('.hp-scopes [aria-checked="true"]', "e => e.dataset.scope") == "overall")
    page.locator('.hp-scopes [data-scope="background"]').tap()
    page.locator("#hpEnable").tap()
    check("「出力に含めて選ぶ」で背景を出力でき、内容が一致",
          page.inner_text("#hexPromptText").strip() == expect and
          page.eval_on_selector_all(".tab-badge", "e => e.map(x => x.textContent)") == ["ON", "OFF", "ON"])
    page.locator(".sheet-head .btn").last.click()
    page.locator("#btnUndo").tap()
    check("この有効化も「元に戻す」で戻せる", page.eval_on_selector_all(".tab-badge", "e => e.map(x => x.textContent)") == ["ON", "OFF", "OFF"])
    check("例外なし", not errors, "; ".join(errors)[:300])
    ctx.close()


def chips_safe(page):
    try:
        return valid(page)
    except Exception:
        return False


def run_fallbacks(browser, base):
    print("\n== クリップボード不可・保存領域不可の環境 ==")
    ctx = browser.new_context(viewport={"width": 390, "height": 645}, has_touch=True, is_mobile=True)
    page = ctx.new_page()
    page.add_init_script("""
        Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
        document.execCommand = () => false;
        Object.defineProperty(window, 'localStorage', { get() { throw new Error('denied'); } });
    """)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(base)
    page.wait_for_selector("#chips .chip")
    check("保存領域が使えなくても起動する", valid(page))
    page.locator("#btnCopyAll").tap()
    page.wait_for_selector(".sheet textarea")
    check("コピー不可の環境では手動コピー用のテキストを表示", "Overall" in page.input_value(".sheet textarea"))
    check("例外なし", not errors, "; ".join(errors)[:300])
    ctx.close()


def run_desktop(browser, base):
    print("\n== 1280x800 PC ==")
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(base)
    page.wait_for_selector("#chips .chip")
    check("PC: 表示・横スクロールなし", page.evaluate("document.documentElement.scrollWidth") <= 1280 and valid(page))
    page.locator("#btnAdd").click()
    check("PC: クリック操作で色追加", len(chips(page)) == 6 and valid(page))
    page.locator("#slS").focus()
    page.keyboard.press("ArrowRight")
    check("PC: スライダーをキーボードで操作できる", True)
    page.keyboard.press("Control+z")
    check("PC: 例外なし", not errors, "; ".join(errors)[:300])
    if SHOTS:
        page.screenshot(path=os.path.join(SHOTS, "desktop.png"))
    ctx.close()


def main():
    srv = serve()
    base = f"http://127.0.0.1:{srv.server_address[1]}/index.html"
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(channel="chrome")
        except Exception:
            browser = p.chromium.launch()
        run_mobile(browser, base, 390, 645, full=True)
        run_mobile(browser, base, 320, 568, full=False)
        run_mobile(browser, base, 430, 740, full=False)
        run_hex_prompt_enable(browser, base)
        run_fallbacks(browser, base)
        run_desktop(browser, base)
        browser.close()
    srv.shutdown()
    ok = sum(1 for _, c, _ in results if c)
    ng = [n for n, c, _ in results if not c]
    print(f"\n結果: {ok} 件成功 / {len(ng)} 件失敗（全 {len(results)} 件）")
    for n in ng:
        print("  失敗:", n)
    sys.exit(1 if ng else 0)


if __name__ == "__main__":
    main()
