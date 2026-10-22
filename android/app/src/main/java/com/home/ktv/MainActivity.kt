package com.home.ktv

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector
import androidx.media3.ui.PlayerView
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * 投影仪端原生播放器 v3.1
 *
 * 遥控器键位（家庭 KTV 习惯，整机只有这一个 App）：
 *   OK          播放 / 暂停（不弹系统控制器）
 *   ←           双击=重唱     长按 ←   2 倍速快退
 *   →           双击=切歌     长按 →   2 倍速快进
 *   ↑           切换原唱 / 伴唱
 *   ↓           显示 / 隐藏操作菜单（唯一一组控制按钮，平时不占屏幕）
 *   功能键(MENU) 播放页=已点列表开关；点歌台内=依次切换大类（歌名→歌星→排行→收藏→已点）
 *   返回         播放页第一次进点歌台（歌继续唱）；点歌台内返回播放页
 *
 * 点歌台布局（参考手绘稿）：
 *   左侧歌曲列表（序号红/歌名白/歌手青/类型蓝/语种粉）
 *   中间字母+数字索引大按钮（默认光标停在 M）
 *   右侧点歌二维码 + 快捷键说明
 *   底部大类：歌名 / 歌星 / 排行 / 收藏 / 已点
 *   播放页不显示二维码与快捷键说明，不遮挡视频画面
 *
 * 播放权威仍在 NAS，本机只负责解码与按键，音轨切换用 TrackSelectionOverride 瞬时完成。
 */
@UnstableApi
class MainActivity : AppCompatActivity() {

    companion object {
        /** 出厂默认 NAS 地址：装完打开就能连，不用手输 */
        const val DEFAULT_SERVER = "http://192.168.1.100:9188"
        // 配色（和手机/网页端保持一致）
        const val C_BG = 0xFF0F1117.toInt()
        const val C_CARD = 0xFF171923.toInt()
        const val C_CARD2 = 0xFF1F2230.toInt()
        const val C_TXT = 0xFFEEF1F7.toInt()
        const val C_MUT = 0xFF8F97A8.toInt()
        const val C_ACC = 0xFFFF4D6D.toInt()
        const val C_OK = 0xFF37D67A.toInt()
        const val C_GOLD = 0xFFFFB347.toInt()
        const val C_FOCUS = 0xFFFF4D6D.toInt()
        // 歌曲行分色（参考点歌台手绘稿：歌名白/歌手青/类型蓝/语种粉）
        const val C_ARTIST = 0xFF4FC3F7.toInt()
        const val C_TYPE = 0xFF7986CB.toInt()
        const val C_LANG = 0xFFF48FB1.toInt()
    }

    private val main = Handler(Looper.getMainLooper())
    private val http = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private lateinit var player: ExoPlayer
    private var trackSelector: DefaultTrackSelector? = null

    private lateinit var playerView: PlayerView
    private lateinit var idleView: View
    private lateinit var topBar: View
    private lateinit var queuePanel: View
    private lateinit var queueListBox: LinearLayout
    private lateinit var queueTitle: TextView
    private lateinit var preparing: TextView
    private lateinit var qrBig: ImageView
    private lateinit var qrSide: ImageView
    private lateinit var nowTitle: TextView
    private lateinit var nowArtist: TextView
    private lateinit var trackBadge: TextView
    private lateinit var queueBadge: TextView
    private lateinit var actionMenu: View

    // 点歌台
    private lateinit var browserPanel: LinearLayout
    private lateinit var browserTitle: TextView
    private lateinit var tabRow: LinearLayout
    private lateinit var chipsRow: LinearLayout
    private lateinit var lettersGrid: LinearLayout
    private lateinit var listContainer: LinearLayout

    private var serverBase = ""
    private var lastToken = -1
    private var loadSeq = 0
    private var pendingTrack = 0
    private var queueOpen = false
    private var menuOpen = false
    private var favIds = HashSet<String>()
    private var currentSongId = ""
    private var currentIsFav = false
    private var hasCurrent = false
    private var errorShown = false
    private var compatMode = false

    // 长按左右快进快退
    private var seekDir = 0
    private var longPressHandled = false
    // 双击左右 = 重唱 / 切歌
    private var lastTapLeft = 0L
    private var lastTapRight = 0L
    private var lastQueue: JSONArray = JSONArray()
    // 点歌台里每个「点歌 / 收藏」按钮的引用，状态一变就能立刻改色
    private val orderButtons = LinkedHashMap<String, Button>()
    private val favButtons = LinkedHashMap<String, Button>()
    // 字母索引按钮（key：'A'..'Z'、'0'..'9'、' ' = 全部）
    private val letterButtons = HashMap<Char, Button>()

    private val seekStartLeft = Runnable { startSeek(-1); longPressHandled = true }
    private val seekStartRight = Runnable { startSeek(1); longPressHandled = true }

    private enum class Tab(val label: String) { SONGS("歌名"), ARTISTS("歌星"), HOT("排行"), FAVS("收藏"), QUEUE("已点") }
    private var tab = Tab.SONGS
    private var letter = ""
    private var lang = ""
    private var type = ""
    private var region = ""
    private var gender = ""
    private var artistName = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_main)

        playerView = findViewById(R.id.playerView)
        idleView = findViewById(R.id.idleView)
        topBar = findViewById(R.id.topBar)
        queuePanel = findViewById(R.id.queuePanel)
        queueListBox = findViewById(R.id.queueList)
        queueTitle = findViewById(R.id.queueTitle)
        preparing = findViewById(R.id.preparing)
        qrBig = findViewById(R.id.qrBig)
        qrSide = findViewById(R.id.qrSide)
        nowTitle = findViewById(R.id.nowTitle)
        nowArtist = findViewById(R.id.nowArtist)
        trackBadge = findViewById(R.id.trackBadge)
        queueBadge = findViewById(R.id.queueBadge)
        actionMenu = findViewById(R.id.actionMenu)
        browserPanel = findViewById(R.id.browserPanel)
        browserTitle = findViewById(R.id.browserTitle)
        tabRow = findViewById(R.id.tabRow)
        chipsRow = findViewById(R.id.chipsRow)
        lettersGrid = findViewById(R.id.lettersGrid)
        listContainer = findViewById(R.id.listContainer)

        serverBase = getSharedPreferences("ktv", MODE_PRIVATE).getString("server", "") ?: ""
        if (serverBase.isEmpty()) askForServer() else boot()
    }

    private fun askForServer() {
        val input = EditText(this)
        input.hint = DEFAULT_SERVER
        input.setText(serverBase.ifEmpty { DEFAULT_SERVER })
        AlertDialog.Builder(this)
            .setTitle("连接家里的 KTV 服务器")
            .setMessage("默认是 NAS 地址 $DEFAULT_SERVER，直接点「连接」即可（地址不同再改）")
            .setView(input)
            .setCancelable(false)
            .setPositiveButton("连接") { _, _ ->
                var v = input.text.toString().trim()
                if (!v.startsWith("http")) v = "http://$v"
                serverBase = v.trimEnd('/')
                getSharedPreferences("ktv", MODE_PRIVATE).edit().putString("server", serverBase).apply()
                boot()
            }
            .setNegativeButton("退出") { _, _ -> finish() }
            .show()
    }

    private fun boot() {
        setupPlayer()
        renderQr()
        connectSse()
        bindButtons()
        setupBrowser()
        styleAllButtons()
    }

    /* ---------------- 通用样式 ---------------- */

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun roundBg(fill: Int, stroke: Int = Color.TRANSPARENT, strokeW: Int = 0, radius: Int = 12): GradientDrawable {
        val d = GradientDrawable()
        d.shape = GradientDrawable.RECTANGLE
        d.cornerRadius = dp(radius).toFloat()
        d.setColor(fill)
        if (strokeW > 0 && stroke != Color.TRANSPARENT) d.setStroke(dp(strokeW), stroke)
        return d
    }

    /** 所有按钮统一成深色圆角；获得焦点时整块变红——投影仪上"选中/未选中"必须一眼能分清 */
    private fun styleButton(b: Button, primary: Boolean = false) {
        b.isAllCaps = false
        b.typeface = Typeface.DEFAULT_BOLD
        b.textSize = if (primary) 15f else 13.5f
        b.setPadding(dp(14), dp(8), dp(14), dp(8))
        b.setTextColor(Color.WHITE)
        b.background = roundBg(if (primary) C_ACC else C_CARD2, 0xFF3A3F52.toInt(), 1)
        b.isFocusable = true
        b.isFocusableInTouchMode = true
        b.setOnFocusChangeListener { _, has ->
            b.background = roundBg(if (has) C_FOCUS else if (primary) C_ACC else C_CARD2, if (has) 0xFFFFFFFF.toInt() else 0xFF3A3F52.toInt(), if (has) 2 else 1)
            b.setTextColor(if (has) Color.WHITE else C_TXT)
            b.scaleX = if (has) 1.06f else 1f
            b.scaleY = if (has) 1.06f else 1f
        }
    }

    private fun styleAllButtons() {
        listOf(
            R.id.btnBrowserClose, R.id.btnOpenBrowser, R.id.btnSettings,
            R.id.btnQShuffle, R.id.btnQClear,
            R.id.amPause, R.id.amNext, R.id.amReplay, R.id.amTrack, R.id.amRewind,
            R.id.amForward, R.id.amFav, R.id.amSongs,
        ).forEach { id ->
            (findViewById<View>(id) as? Button)?.let { styleButton(it) }
        }
    }

    /* ---------------- 播放器 ---------------- */

    private fun setupPlayer() {
        // 禁用系统自带的播放控制层：按 OK 只暂停，屏幕中央不再弹出播放圆盘、画面不再被压暗
        playerView.useController = false
        trackSelector = DefaultTrackSelector(this)
        val selector = trackSelector ?: return
        player = ExoPlayer.Builder(this)
            .setTrackSelector(selector)
            .build()
        playerView.player = player
        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_READY) applyAudioTrack(pendingTrack)
                if (playbackState == Player.STATE_ENDED) {
                    Thread { post("/api/player/report", """{"ended":true}""") }.start()
                }
            }

            override fun onPlayerError(error: PlaybackException) {
                val codeName = error.errorCodeName
                main.post {
                    // 首次失败多半是设备解不了音频（KTV 片源常见 MP2，安卓只认 MP3 层）：
                    // 自动改走兼容流重试一次（服务端换封装 + 音频转 AAC，视频仍不转码）
                    if (!compatMode) {
                        preparing.visibility = View.VISIBLE
                        preparing.text = "音频格式不被支持，正在转换…"
                        loadSong(currentSongId, 0.0, pendingTrack, forceCompat = true)
                        return@post
                    }
                    showPlayError("播放失败：$codeName", retryable = true)
                }
            }
        })

        main.postDelayed(object : Runnable {
            override fun run() {
                if (player.isPlaying) {
                    val body = """{"position":${player.currentPosition / 1000.0}}"""
                    Thread { post("/api/player/report", body) }.start()
                }
                main.postDelayed(this, 2500)
            }
        }, 2500)
    }

    private fun applyAudioTrack(index: Int) {
        val group = player.currentTracks.groups.firstOrNull { it.type == C.TRACK_TYPE_AUDIO } ?: return
        val mtg = group.mediaTrackGroup
        if (index >= mtg.length) return
        player.trackSelectionParameters = player.trackSelectionParameters
            .buildUpon()
            .setOverrideForType(TrackSelectionOverride(mtg, index))
            .build()
    }

    private fun loadSong(songId: String, seekTo: Double, track: Int, forceCompat: Boolean = false) {
        val seq = ++loadSeq
        compatMode = forceCompat
        main.post {
            errorShown = false
            preparing.visibility = View.VISIBLE
            preparing.text = "正在准备…"
        }
        Thread {
            var url = ""
            var errMsg = ""
            var waited = 0
            while (waited < 180) {
                if (seq != loadSeq) return@Thread
                val body = get(
                    "/api/prepare/$songId?track=$track&client=apk&start=1" + if (forceCompat) "&compat=1" else ""
                )
                if (body == null) {
                    Thread.sleep(1200)
                    waited++
                    continue
                }
                val o = try { JSONObject(body) } catch (e: Exception) { JSONObject() }
                when (o.optString("state")) {
                    "ready" -> {
                        url = o.optString("url").ifEmpty { "/stream/$songId?track=$track&client=apk" }
                        break
                    }
                    "unsupported" -> {
                        errMsg = o.optString("error").ifEmpty { "该片源无法播放" }
                        break
                    }
                    "error" -> {
                        errMsg = o.optString("error").ifEmpty { "音轨处理失败" }
                        break
                    }
                    "off", "none", "" -> {
                        url = "/stream/$songId?track=$track&client=apk"
                        break
                    }
                    else -> {
                        val p = o.optInt("progress", 0)
                        main.post { preparing.text = "正在准备这首的音轨… $p%" }
                    }
                }
                Thread.sleep(700)
                waited++
            }
            if (seq != loadSeq) return@Thread
            if (url.isEmpty()) {
                if (errMsg.isNotEmpty()) showPlayError(errMsg, retryable = false)
                return@Thread
            }

            var tries = 0
            while (tries < 240) {
                if (seq != loadSeq) return@Thread
                val code = headCode(url)
                if (code != 425) break
                main.post { preparing.text = "正在处理音轨，请稍候…" }
                Thread.sleep(1000)
                tries++
            }
            if (seq != loadSeq) return@Thread
            if (tries >= 240) {
                showPlayError("处理超时，请稍后重试", retryable = true)
                return@Thread
            }

            main.post {
                pendingTrack = track
                player.setMediaItem(MediaItem.fromUri(serverBase + url))
                player.prepare()
                if (seekTo > 1) player.seekTo((seekTo * 1000).toLong())
                player.play()
                preparing.visibility = View.GONE
            }
        }.start()
    }

    private fun showPlayError(msg: String, retryable: Boolean) {
        main.post {
            player.stop()
            errorShown = true
            preparing.visibility = View.VISIBLE
            preparing.text = "$msg\n" + if (retryable) "OK 键重试 · 返回键跳过" else "返回键跳过这首"
        }
    }

    private fun skipBrokenSong() {
        errorShown = false
        preparing.visibility = View.GONE
        player.stop()
        player.clearMediaItems()
        lastToken = -1
        Thread { post("/api/player/next") }.start()
    }

    private fun retryCurrent() {
        if (currentSongId.isEmpty()) return
        errorShown = false
        loadSong(currentSongId, 0.0, pendingTrack, forceCompat = true)
    }

    /* ---------------- 服务端状态（SSE） ---------------- */

    private fun connectSse() {
        val req = Request.Builder().url("$serverBase/api/events?role=player").build()
        http.newCall(req).enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
                main.postDelayed({ connectSse() }, 3000)
            }

            override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
                response.use { resp ->
                    val source = resp.body?.source() ?: return
                    var event = ""
                    while (true) {
                        val line = source.readUtf8Line() ?: break
                        when {
                            line.startsWith("event:") -> event = line.substring(6).trim()
                            line.startsWith("data:") -> {
                                val data = line.substring(5).trim()
                                if (event == "state") main.post { handleState(data) }
                                event = ""
                            }
                        }
                    }
                }
                main.postDelayed({ connectSse() }, 3000)
            }
        })
    }

    /** 点歌台开着时，顶部歌曲信息必须让位，不然叠在列表上；播放页只留歌名，不挡画面 */
    private fun overlayVisibility(): Int =
        if (browserPanel.visibility == View.VISIBLE || !hasCurrent) View.GONE else View.VISIBLE

    @SuppressLint("SetTextI18n")
    private fun handleState(json: String) {
        val state = JSONObject(json)
        val current = state.optJSONObject("current")
        val queue = state.optJSONArray("queue") ?: JSONArray()
        lastQueue = queue

        favIds.clear()
        val favs = state.optJSONArray("favIds") ?: JSONArray()
        for (i in 0 until favs.length()) favIds.add(favs.optString(i))

        queueBadge.text = "已点 ${queue.length()} 首"
        renderQueue(queue)
        // 点歌台里"点歌"按钮要能立刻变成"已点"，把当前状态传进去
        if (browserPanel.visibility == View.VISIBLE) {
            refreshOrderButtons()
            if (tab == Tab.QUEUE) refreshBrowser()
        }

        if (current == null) {
            hasCurrent = false
            idleView.visibility = if (browserPanel.visibility == View.VISIBLE) View.GONE else View.VISIBLE
            topBar.visibility = View.GONE
            if (!queueOpen) queuePanel.visibility = View.GONE
            hideActionMenu()
            currentSongId = ""
            player.stop()
            player.clearMediaItems()
            lastToken = -1
            preparing.visibility = View.GONE
            return
        }

        idleView.visibility = View.GONE
        hasCurrent = true
        topBar.visibility = overlayVisibility()

        val song = current.getJSONObject("song")
        val track = current.optInt("track", 0)
        val trackCount = current.optInt("trackCount", 1)
        val isAcc = current.optString("trackRole", "orig") == "acc"
        currentSongId = song.optString("id")
        nowTitle.text = song.optString("title")
        val lang = song.optString("lang", "")
        nowArtist.text = song.optString("artist") + (if (lang.isNotEmpty()) " · $lang" else "") +
            (if (current.optString("by", "").isNotEmpty()) " · ${current.optString("by")}点的" else "")
        trackBadge.text = if (trackCount > 1) (if (isAcc) "伴唱" else "原唱") else "单音轨"
        trackBadge.setBackgroundColor(if (isAcc) C_GOLD else C_ACC)
        trackBadge.setTextColor(if (isAcc) 0xFF2A1B06.toInt() else Color.WHITE)
        (findViewById<View>(R.id.amTrack) as? Button)?.apply {
            text = "🎤 " + (if (isAcc) "伴唱" else "原唱")
            isEnabled = trackCount > 1
        }
        (findViewById<View>(R.id.amPause) as? Button)?.text =
            if (current.optBoolean("paused")) "▶ 播放" else "⏸ 暂停"

        // 收藏状态：用颜色 + 文案表达，不再靠 emoji 的颜色（emoji 永远红，之前就是它骗了人）
        currentIsFav = favIds.contains(currentSongId)
        applyFavStyle()

        // 只在"这首还没准备完"时才在前台显示进度；其余预热在后台静默进行
        val prep = current.optJSONObject("prepare")
        val st = prep?.optString("state") ?: ""
        if (st == "running" || st == "queued" || st == "probing" || st == "pending") {
            val p = prep?.optInt("progress", 0) ?: 0
            preparing.text = "正在准备这首的音轨… $p%"
            preparing.visibility = View.VISIBLE
        } else if (!errorShown) {
            preparing.visibility = View.GONE
        }

        val token = current.optInt("token", 0)
        if (token != lastToken) {
            lastToken = token
            val pos = current.optDouble("position", 0.0)
            val posAt = current.optLong("positionAt", System.currentTimeMillis())
            val est = if (current.optBoolean("paused")) pos else pos + (System.currentTimeMillis() - posAt) / 1000.0
            loadSong(song.optString("id"), est, track)
        }
    }

    private fun applyFavStyle() {
        (findViewById<View>(R.id.amFav) as? Button)?.apply {
            text = if (currentIsFav) "♥ 已收藏" else "♡ 收藏"
            background = roundBg(if (currentIsFav) C_ACC else C_CARD2, if (currentIsFav) C_ACC else 0xFF3A3F52.toInt(), 1)
        }
    }

    /* ---------------- 已点列表（播放页侧栏） ---------------- */

    @SuppressLint("SetTextI18n")
    private fun renderQueue(queue: JSONArray) {
        queueTitle.text = "已点 ${queue.length()} 首"
        queueListBox.removeAllViews()
        if (queue.length() == 0) {
            queueListBox.addView(hintRow("还没有人点歌\n用遥控器点歌台或手机扫码"))
            return
        }
        for (i in 0 until queue.length()) {
            val item = queue.getJSONObject(i)
            val song = item.getJSONObject("song")
            val qid = item.optString("qid")
            val by = item.optString("by", "")
            val prep = item.optJSONObject("prepare")
            val st = prep?.optString("state") ?: ""
            val busy = st == "running" || st == "queued" || st == "probing" || st == "pending"

            val row = LinearLayout(this)
            row.orientation = LinearLayout.HORIZONTAL
            row.gravity = Gravity.CENTER_VERTICAL
            row.background = roundBg(C_CARD, 0xFF2A2F3D.toInt(), 1)
            row.setPadding(dp(10), dp(9), dp(8), dp(9))
            row.layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { setMargins(0, 0, 0, dp(6)) }

            val idx = TextView(this)
            idx.text = "${i + 1}"
            idx.setTextColor(C_GOLD)
            idx.textSize = 14f
            idx.typeface = Typeface.DEFAULT_BOLD
            idx.width = dp(24)
            row.addView(idx)

            val mid = LinearLayout(this)
            mid.orientation = LinearLayout.VERTICAL
            val t1 = TextView(this)
            t1.text = song.optString("title")
            t1.setTextColor(Color.WHITE)
            t1.textSize = 14.5f
            t1.typeface = Typeface.DEFAULT_BOLD
            t1.isSingleLine = true
            t1.ellipsize = android.text.TextUtils.TruncateAt.END
            val t2 = TextView(this)
            t2.text = song.optString("artist") + (if (by.isNotEmpty()) " · $by" else "") +
                (if (busy) "　读取音轨中" + (prep?.optInt("progress", 0)?.takeIf { it > 0 }?.let { " $it%" } ?: "…") else "")
            t2.setTextColor(if (busy) C_GOLD else C_MUT)
            t2.textSize = 12f
            mid.addView(t1)
            mid.addView(t2)
            mid.layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            row.addView(mid)

            val top = Button(this)
            top.text = "⬆"
            styleButton(top)
            top.setOnClickListener {
                Thread { post("/api/queue/$qid/top") }.start()
                toastMsg("已置顶")
            }
            row.addView(top)

            val del = Button(this)
            del.text = "✕"
            styleButton(del)
            del.layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { leftMargin = dp(6) }
            del.setOnClickListener {
                Thread { post("/api/queue/$qid/remove") }.start()
            }
            row.addView(del)

            queueListBox.addView(row)
        }
    }

    /* ---------------- 交互 ---------------- */

    private fun bindButtons() {
        findViewById<Button>(R.id.btnOpenBrowser).setOnClickListener { openBrowser() }
        findViewById<Button>(R.id.btnSettings).setOnClickListener { showSettings() }
        findViewById<Button>(R.id.btnBrowserClose).setOnClickListener { closeBrowser() }
        findViewById<Button>(R.id.btnQShuffle).setOnClickListener {
            Thread {
                val ok = post("/api/queue/shuffle")
                main.post { toastMsg(if (ok) "已打乱顺序" else "至少要有两首") }
            }.start()
        }
        findViewById<Button>(R.id.btnQClear).setOnClickListener {
            Thread { post("/api/queue/clear") }.start()
            toastMsg("已清空")
        }

        // 方向下键弹出的操作菜单（播放页唯一一组控制按钮）
        findViewById<Button>(R.id.amPause).setOnClickListener { togglePlay() }
        findViewById<Button>(R.id.amNext).setOnClickListener { doNext() }
        findViewById<Button>(R.id.amReplay).setOnClickListener { doReplay() }
        findViewById<Button>(R.id.amTrack).setOnClickListener { toggleTrack() }
        findViewById<Button>(R.id.amFav).setOnClickListener { toggleFav() }
        findViewById<Button>(R.id.amSongs).setOnClickListener { openBrowser() }
        findViewById<Button>(R.id.amRewind).setOnClickListener { startSeek(-1); main.postDelayed({ stopSeek() }, 2000) }
        findViewById<Button>(R.id.amForward).setOnClickListener { startSeek(1); main.postDelayed({ stopSeek() }, 2000) }

        // 点画面 = 显示/隐藏操作菜单（触屏备用，遥控器用 ↓）
        playerView.setOnClickListener {
            if (browserPanel.visibility != View.VISIBLE && hasCurrent) {
                if (menuOpen) hideActionMenu() else showActionMenu()
            }
        }
    }

    private fun togglePlay() {
        Thread { post("/api/player/toggle") }.start()
    }

    private fun doNext() {
        Thread { post("/api/player/next") }.start()
        toastMsg("切歌")
    }

    private fun doReplay() {
        Thread { post("/api/player/replay") }.start()
        toastMsg("重唱")
    }

    private fun toggleTrack() {
        Thread { post("/api/player/toggle-track") }.start()
    }

    private fun toggleFav() {
        if (currentSongId.isEmpty()) return
        Thread {
            val r = post("/api/favs/toggle", """{"songId":"$currentSongId"}""")
            main.post {
                if (!r) return@post
                // 以服务端返回为准，别自己猜
                val body = get("/api/state") ?: return@post
                val favs = JSONObject(body).optJSONArray("favIds") ?: JSONArray()
                val set = HashSet<String>()
                for (i in 0 until favs.length()) set.add(favs.optString(i))
                favIds = set
                currentIsFav = favIds.contains(currentSongId)
                applyFavStyle()
                refreshOrderButtons()
                toastMsg(if (currentIsFav) "已收藏 ❤" else "已取消收藏")
            }
        }.start()
    }

    /* ---------------- 快捷键 / 遥控器 ---------------- */

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        // 播放失败浮层：任何键都要能出去
        if (errorShown) {
            when (keyCode) {
                KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_ESCAPE -> { skipBrokenSong(); return true }
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> { retryCurrent(); return true }
            }
        }

        // 返回键：播放页 → 点歌台 → 播放页（后台歌曲不停）；菜单开着先收菜单
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (menuOpen) { hideActionMenu(); return true }
            if (browserPanel.visibility == View.VISIBLE) {
                if (artistName.isNotEmpty()) {
                    artistName = ""
                    refreshBrowser()
                } else {
                    closeBrowser()
                }
                return true
            }
            openBrowser()
            return true
        }

        // 三道杠：播放页=已点开关；点歌台=依次切换大类
        if (keyCode == KeyEvent.KEYCODE_MENU || keyCode == KeyEvent.KEYCODE_SETTINGS) {
            if (browserPanel.visibility == View.VISIBLE) {
                cycleTab()
            } else {
                toggleQueuePanel()
            }
            return true
        }

        val inBrowser = browserPanel.visibility == View.VISIBLE
        if (inBrowser) return super.onKeyDown(keyCode, event)

        // 菜单打开时，方向键交给系统做焦点导航（↓ 自己收起菜单）
        if (menuOpen) {
            if (keyCode == KeyEvent.KEYCODE_DPAD_DOWN) { hideActionMenu(); return true }
            return super.onKeyDown(keyCode, event)
        }

        when (keyCode) {
            KeyEvent.KEYCODE_DPAD_LEFT -> {
                if ((event?.repeatCount ?: 0) == 0 && hasCurrent) {
                    longPressHandled = false
                    main.postDelayed(seekStartLeft, 420)
                }
                return true
            }
            KeyEvent.KEYCODE_DPAD_RIGHT -> {
                if ((event?.repeatCount ?: 0) == 0 && hasCurrent) {
                    longPressHandled = false
                    main.postDelayed(seekStartRight, 420)
                }
                return true
            }
            KeyEvent.KEYCODE_DPAD_UP -> {
                if (hasCurrent) toggleTrack()
                return true
            }
            KeyEvent.KEYCODE_DPAD_DOWN -> {
                if (hasCurrent) showActionMenu()
                return true
            }
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> {
                // 按下时就响应，长按 OK 会连发，靠 repeatCount 去重
                if ((event?.repeatCount ?: 0) == 0 && hasCurrent) togglePlay()
                return true
            }
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> { togglePlay(); return true }
            KeyEvent.KEYCODE_MEDIA_NEXT -> { doNext(); return true }
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        if (errorShown) return super.onKeyUp(keyCode, event)
        if (menuOpen || browserPanel.visibility == View.VISIBLE) return super.onKeyUp(keyCode, event)
        when (keyCode) {
            KeyEvent.KEYCODE_DPAD_LEFT -> {
                main.removeCallbacks(seekStartLeft)
                if (longPressHandled) {
                    stopSeek(); longPressHandled = false
                } else if (hasCurrent) {
                    // 双击 = 重唱（600ms 内两次短按）；单击不动作，防误触
                    val now = System.currentTimeMillis()
                    if (now - lastTapLeft < 600) { lastTapLeft = 0; doReplay() } else lastTapLeft = now
                }
                return true
            }
            KeyEvent.KEYCODE_DPAD_RIGHT -> {
                main.removeCallbacks(seekStartRight)
                if (longPressHandled) {
                    stopSeek(); longPressHandled = false
                } else if (hasCurrent) {
                    // 双击 = 切歌（600ms 内两次短按）；单击不动作，防误触
                    val now = System.currentTimeMillis()
                    if (now - lastTapRight < 600) { lastTapRight = 0; doNext() } else lastTapRight = now
                }
                return true
            }
        }
        return super.onKeyUp(keyCode, event)
    }

    /** 2 倍速快进/快退：每 250ms 走 0.5 秒 */
    private fun startSeek(dir: Int) {
        seekDir = dir
        toastMsg(if (dir > 0) "⏩ 快进 ×2" else "⏪ 快退 ×2")
        main.removeCallbacks(seekTicker)
        main.post(seekTicker)
    }

    private val seekTicker = object : Runnable {
        override fun run() {
            if (seekDir == 0) return
            val dur = try { player.duration } catch (e: Exception) { 0L }
            val max = if (dur > 0) dur else Long.MAX_VALUE
            val target = (player.currentPosition + seekDir * 500L).coerceIn(0L, max)
            player.seekTo(target)
            main.postDelayed(this, 250)
        }
    }

    private fun stopSeek() {
        if (seekDir == 0) return
        seekDir = 0
        main.removeCallbacks(seekTicker)
        val pos = player.currentPosition / 1000.0
        Thread { post("/api/player/report", """{"position":$pos}""") }.start()
    }

    private fun showActionMenu() {
        menuOpen = true
        actionMenu.visibility = View.VISIBLE
        findViewById<View>(R.id.amPause)?.requestFocus()
        main.postDelayed({ if (menuOpen) hideActionMenu() }, 15000)
    }

    private fun hideActionMenu() {
        menuOpen = false
        actionMenu.visibility = View.GONE
    }

    private fun toggleQueuePanel() {
        queueOpen = !queueOpen
        queuePanel.visibility = if (queueOpen) View.VISIBLE else View.GONE
        if (queueOpen) {
            queueBadge.text = "已点 ${lastQueue.length()} 首"
            renderQueue(lastQueue)
        }
    }

    /* ---------------- 设置 ---------------- */

    private fun showSettings() {
        Thread {
            val cfg = try {
                JSONObject(get("/api/settings") ?: "{}")
            } catch (e: Exception) {
                JSONObject()
            }
            val modes = arrayOf("off", "random", "favs")
            val modeLabels = arrayOf("不自动播放", "空闲随机播放", "空闲播放收藏歌曲")
            var selected = modes.indexOf(cfg.optString("autoplayMode", "off")).coerceAtLeast(0)
            main.post {
                val container = LinearLayout(this)
                container.orientation = LinearLayout.VERTICAL
                val pad = dp(20)
                container.setPadding(pad, pad / 2, pad, 0)

                val label = TextView(this)
                label.text = "服务器地址"
                container.addView(label)
                val input = EditText(this)
                input.hint = DEFAULT_SERVER
                input.setText(serverBase.ifEmpty { DEFAULT_SERVER })
                container.addView(input)

                val label2 = TextView(this)
                label2.text = "开机/空闲自动播放"
                label2.setPadding(0, pad / 2, 0, 0)
                container.addView(label2)

                val checked = BooleanArray(modes.size) { i -> i == selected }
                val radioLayout = LinearLayout(this)
                radioLayout.orientation = LinearLayout.VERTICAL
                modes.forEachIndexed { i, m ->
                    val rb = android.widget.RadioButton(this)
                    rb.text = modeLabels[i]
                    rb.isChecked = checked[i]
                    rb.setOnCheckedChangeListener { _, isChecked ->
                        if (isChecked) {
                            checked.fill(false)
                            checked[i] = true
                            radioLayout.forEach { v -> (v as? android.widget.RadioButton)?.isChecked = v === rb }
                        }
                    }
                    radioLayout.addView(rb)
                }
                container.addView(radioLayout)

                AlertDialog.Builder(this)
                    .setTitle("设置")
                    .setView(container)
                    .setPositiveButton("保存") { _, _ ->
                        var v = input.text.toString().trim()
                        if (v.isNotEmpty()) {
                            if (!v.startsWith("http")) v = "http://$v"
                            val newBase = v.trimEnd('/')
                            if (newBase != serverBase) {
                                serverBase = newBase
                                getSharedPreferences("ktv", MODE_PRIVATE).edit().putString("server", serverBase).apply()
                                renderQr()
                            }
                        }
                        val mode = modes[checked.indexOfFirst { it }.coerceAtLeast(0)]
                        Thread {
                            post("/api/settings", """{"autoplayMode":"$mode"}""")
                            main.post { toastMsg("设置已保存") }
                        }.start()
                    }
                    .setNegativeButton("取消", null)
                    .show()
            }
        }.start()
    }

    /* ---------------- 点歌台 ---------------- */

    private fun setupBrowser() {
        // 底部大类栏
        tabRow.removeAllViews()
        Tab.values().forEach { t ->
            val b = chipButton(t.label)
            b.tag = "tab:${t.name}"
            b.setOnClickListener {
                tab = t
                artistName = ""
                refreshBrowser()
            }
            tabRow.addView(b)
        }
        // 中间字母 / 数字索引：每行 5 个大按钮
        // A-E F-J K-O P-T U-Y | Z 0 1 2 3 | 4 5 6 7 8 | 9 全
        lettersGrid.removeAllViews()
        letterButtons.clear()
        val keys: List<Char> = ('A'..'Z') + ('0'..'9') + ' '
        keys.chunked(5).forEach { rowKeys ->
            val rowBox = LinearLayout(this)
            rowBox.orientation = LinearLayout.HORIZONTAL
            rowBox.layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
            )
            rowKeys.forEach { c ->
                val label = if (c == ' ') "全" else c.toString()
                val b = letterChip(label)
                b.tag = "letter:$c"
                b.setOnClickListener {
                    letter = if (c == ' ') "" else c.toString()
                    if (tab == Tab.QUEUE || tab == Tab.FAVS) tab = Tab.SONGS
                    artistName = ""
                    refreshBrowser()
                }
                letterButtons[c] = b
                val lp = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                val m = dp(3)
                lp.setMargins(m, m, m, m)
                rowBox.addView(b, lp)
            }
            lettersGrid.addView(rowBox)
        }
    }

    /** 点歌台内按三道杠：歌名 → 歌星 → 排行 → 收藏 → 已点 → 歌名 */
    private fun cycleTab() {
        val values = Tab.values()
        tab = values[(tab.ordinal + 1) % values.size]
        artistName = ""
        refreshBrowser()
    }

    private fun openBrowser() {
        // 回到"点歌首页"：歌名大类、不筛字母；光标停在中间的字母 M 上
        tab = Tab.SONGS
        artistName = ""
        letter = ""
        browserPanel.visibility = View.VISIBLE
        idleView.visibility = View.GONE
        queuePanel.visibility = View.GONE
        queueOpen = false
        hideActionMenu()
        // 隐藏播放页浮层（歌曲信息），避免叠在列表上
        topBar.visibility = View.GONE
        refreshBrowser()
        paintLetters()
        // 光标默认落在第一行的「点歌」按钮上（列表加载完成后 focusFirstOrderButton 接管）；
        // 向左一步=收藏，向右一步=字母索引
    }

    private fun closeBrowser() {
        browserPanel.visibility = View.GONE
        listContainer.removeAllViews()
        orderButtons.clear()
        favButtons.clear()
        // 没在播放时把待机页（二维码）还回来，否则关掉点歌台就是一片黑
        if (!hasCurrent) idleView.visibility = View.VISIBLE
    }

    private fun refreshBrowser() {
        browserTitle.text = if (artistName.isNotEmpty()) "点歌台 · 🎤 $artistName" else "点歌台 · ${tab.label}"
        // 大类选中态：整块填充 + 白字；未选中：深底灰字描边——投影仪远看也能分清
        tabRow.forEach { v ->
            val b = v as Button
            val on = b.text.toString() == tab.label
            b.background = roundBg(if (on) C_ACC else C_CARD2, if (on) C_ACC else 0xFF3A3F52.toInt(), 1)
            b.setTextColor(if (on) Color.WHITE else C_MUT)
            b.typeface = if (on) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
        }
        paintLetters()
        buildChips()
        listContainer.removeAllViews()
        orderButtons.clear()
        favButtons.clear()
        listContainer.addView(hintRow("加载中…"))
        if (tab == Tab.QUEUE) {
            renderQueueTab()
            return
        }
        Thread {
            try {
                when (tab) {
                    Tab.SONGS -> {
                        val songs = if (artistName.isNotEmpty()) songListOf(
                            "/api/songs?artist=" + urlencode(artistName) + "&limit=200"
                        ) else songListOf(
                            "/api/songs?sort=default&lang=" + urlencode(lang) + "&type=" + urlencode(type) +
                                "&letter=" + letter + "&limit=60"
                        )
                        main.post {
                            listContainer.removeAllViews()
                            if (songs.length() == 0) listContainer.addView(hintRow("没有找到歌曲"))
                            for (i in 0 until songs.length()) addSongRow(songs.getJSONObject(i), i + 1)
                            refreshOrderButtons()
                            focusFirstOrderButton()
                        }
                    }
                    Tab.HOT -> {
                        val songs = songListOf("/api/songs?sort=hot&limit=60")
                        main.post {
                            listContainer.removeAllViews()
                            if (songs.length() == 0) listContainer.addView(hintRow("曲库为空"))
                            for (i in 0 until songs.length()) addSongRow(songs.getJSONObject(i), i + 1)
                            refreshOrderButtons()
                            focusFirstOrderButton()
                        }
                    }
                    Tab.FAVS -> {
                        val songs = JSONObject(get("/api/favs") ?: "{}").optJSONArray("items") ?: JSONArray()
                        main.post {
                            listContainer.removeAllViews()
                            if (songs.length() == 0) listContainer.addView(hintRow("还没有收藏，用手机或 ♥ 收藏歌曲"))
                            for (i in 0 until songs.length()) addSongRow(songs.getJSONObject(i), i + 1)
                            refreshOrderButtons()
                            focusFirstOrderButton()
                        }
                    }
                    Tab.ARTISTS -> {
                        if (artistName.isNotEmpty()) {
                            val songs = songListOf("/api/songs?artist=" + urlencode(artistName) + "&limit=200")
                            main.post {
                                listContainer.removeAllViews()
                                for (i in 0 until songs.length()) addSongRow(songs.getJSONObject(i), i + 1)
                                refreshOrderButtons()
                                focusFirstOrderButton()
                            }
                        } else {
                            val artists = JSONObject(
                                get("/api/artists?letter=" + letter + "&region=" + urlencode(region) +
                                    "&gender=" + urlencode(gender) + "&limit=100") ?: "{}"
                            ).optJSONArray("items") ?: JSONArray()
                            main.post {
                                listContainer.removeAllViews()
                                if (artists.length() == 0) listContainer.addView(hintRow("没有找到歌手\n地区/性别可在 NAS 后台设置"))
                                for (i in 0 until artists.length()) addArtistRow(artists.getJSONObject(i))
                            }
                        }
                    }
                    Tab.QUEUE -> renderQueueTab()
                }
            } catch (e: Exception) {
                main.post {
                    listContainer.removeAllViews()
                    listContainer.addView(hintRow("加载失败：${e.message}\n请检查服务器连接"))
                }
            }
        }.start()
    }

    /** 「已点」大类：直接渲染服务端推来的队列，可置顶 / 删除 */
    private fun renderQueueTab() {
        main.post {
            listContainer.removeAllViews()
            orderButtons.clear()
            favButtons.clear()
            if (lastQueue.length() == 0) {
                listContainer.addView(hintRow("已点列表是空的\n按 OK 上的点歌台或用手机扫码点歌"))
                return@post
            }
            for (i in 0 until lastQueue.length()) {
                val item = lastQueue.optJSONObject(i) ?: continue
                val song = item.optJSONObject("song") ?: continue
                addQueueRow(song, item, i + 1)
            }
        }
    }

    @SuppressLint("SetTextI18n")
    private fun addQueueRow(song: JSONObject, item: JSONObject, no: Int) {
        val qid = item.optString("qid")
        val by = item.optString("by", "")
        val prep = item.optJSONObject("prepare")
        val st = prep?.optString("state") ?: ""
        val busy = st == "running" || st == "queued" || st == "probing" || st == "pending"

        val row = LinearLayout(this)
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL
        row.background = roundBg(C_CARD, 0xFF2A2F3D.toInt(), 1)
        row.setPadding(dp(16), dp(12), dp(12), dp(12))
        row.layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { setMargins(0, 0, 0, dp(8)) }

        val idx = TextView(this)
        idx.text = "$no."
        idx.setTextColor(C_GOLD)
        idx.textSize = 16f
        idx.typeface = Typeface.DEFAULT_BOLD
        idx.width = dp(44)
        row.addView(idx)

        val mid = LinearLayout(this)
        mid.orientation = LinearLayout.VERTICAL
        val t1 = TextView(this)
        t1.text = song.optString("title")
        t1.setTextColor(Color.WHITE)
        t1.textSize = 17f
        t1.typeface = Typeface.DEFAULT_BOLD
        t1.isSingleLine = true
        t1.ellipsize = android.text.TextUtils.TruncateAt.END
        val t2 = TextView(this)
        t2.text = song.optString("artist") + (if (by.isNotEmpty()) " · $by" else "") +
            (if (busy) "　读取音轨中 " + (prep?.optInt("progress", 0) ?: 0) + "%" else "")
        t2.setTextColor(if (busy) C_GOLD else C_MUT)
        t2.textSize = 13f
        mid.addView(t1)
        mid.addView(t2)
        mid.layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        row.addView(mid)

        val top = Button(this)
        top.text = "⬆ 置顶"
        styleButton(top)
        top.setOnClickListener {
            Thread { post("/api/queue/$qid/top") }.start()
            toastMsg("已置顶")
        }
        row.addView(top)

        val del = Button(this)
        del.text = "✕"
        styleButton(del)
        del.layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { leftMargin = dp(8) }
        del.setOnClickListener {
            Thread { post("/api/queue/$qid/remove") }.start()
        }
        row.addView(del)

        listContainer.addView(row)
    }

    /** 筛选条：歌名=语种/类型/随机，歌星=地区/性别；点击循环切换 */
    private fun buildChips() {
        chipsRow.removeAllViews()
        when (tab) {
            Tab.SONGS -> {
                chipsRow.addView(chipButton(if (lang.isEmpty()) "语种" else lang).apply {
                    setOnClickListener { cycleLang() }
                })
                chipsRow.addView(chipButton(if (type.isEmpty()) "类型" else type).apply {
                    setOnClickListener { cycleType() }
                })
                chipsRow.addView(chipButton("🎲 随机来一首").apply {
                    setOnClickListener {
                        Thread {
                            try {
                                val arr = JSONObject(get("/api/random?n=1") ?: "{}").optJSONArray("items")
                                if (arr != null && arr.length() > 0) orderSong(arr.getJSONObject(0).optString("id"))
                            } catch (_: Exception) {}
                        }.start()
                    }
                })
            }
            Tab.ARTISTS -> {
                chipsRow.addView(chipButton(if (region.isEmpty()) "地区" else region).apply {
                    setOnClickListener { cycleRegion() }
                })
                chipsRow.addView(chipButton(if (gender.isEmpty()) "歌手" else genderLabel(gender)).apply {
                    setOnClickListener { cycleGender() }
                })
            }
            else -> {}
        }
    }

    private val langOptions = arrayOf("", "国语", "粤语", "闽南语", "英语", "日语", "韩语")
    private val typeOptions = arrayOf("", "流行", "合唱", "对唱", "戏曲", "其他")
    private val regionOptions = arrayOf("", "大陆", "台湾", "香港", "外国", "其他")
    private val genderOptions = arrayOf("", "男", "女", "组合")

    private fun cycleLang() { lang = langOptions[(langOptions.indexOf(lang) + 1) % langOptions.size]; refreshBrowser() }
    private fun cycleType() { type = typeOptions[(typeOptions.indexOf(type) + 1) % typeOptions.size]; refreshBrowser() }
    private fun cycleRegion() { region = regionOptions[(regionOptions.indexOf(region) + 1) % regionOptions.size]; refreshBrowser() }
    private fun cycleGender() { gender = genderOptions[(genderOptions.indexOf(gender) + 1) % genderOptions.size]; refreshBrowser() }

    private fun genderLabel(g: String) = when (g) {
        "男" -> "男歌手"; "女" -> "女歌手"; "组合" -> "组合/乐队"; else -> "全部歌手"
    }

    /** 字母网格的选中态：选中的字母整块变红，未选中深底绿字（参考手绘稿的绿色大字母） */
    private fun paintLetters() {
        letterButtons.forEach { (c, b) ->
            val on = if (c == ' ') letter.isEmpty() else letter == c.toString()
            b.background = roundBg(if (on) C_ACC else C_CARD, if (on) C_ACC else 0xFF2E3342.toInt(), 1)
            b.setTextColor(if (on) Color.WHITE else C_OK)
            b.typeface = if (on) Typeface.DEFAULT_BOLD else Typeface.DEFAULT_BOLD
        }
    }

    private fun letterChip(text: String): Button {
        val b = Button(this)
        b.text = text
        b.textSize = 19f
        b.isAllCaps = false
        b.isSingleLine = true
        b.typeface = Typeface.DEFAULT_BOLD
        b.minWidth = 0
        b.minimumWidth = 0
        b.minimumHeight = 0
        b.setPadding(0, dp(8), 0, dp(8))
        b.setTextColor(C_OK)
        b.background = roundBg(C_CARD, 0xFF2E3342.toInt(), 1)
        b.gravity = Gravity.CENTER
        b.isFocusable = true
        b.isFocusableInTouchMode = true
        b.setOnFocusChangeListener { _, has ->
            if (has) {
                b.background = roundBg(C_FOCUS, 0xFFFFFFFF.toInt(), 2)
                b.setTextColor(Color.WHITE)
                b.scaleX = 1.12f; b.scaleY = 1.12f
            } else {
                paintLetters()
                b.scaleX = 1f; b.scaleY = 1f
            }
        }
        return b
    }

    private fun chipButton(text: String): Button {
        val b = Button(this)
        b.text = text
        b.textSize = 14.5f
        b.isAllCaps = false
        b.isSingleLine = true
        b.typeface = Typeface.DEFAULT_BOLD
        b.setPadding(dp(18), dp(9), dp(18), dp(9))
        b.setTextColor(C_TXT)
        b.background = roundBg(C_CARD2, 0xFF3A3F52.toInt(), 1)
        val m = dp(8)
        b.layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { rightMargin = m }
        b.isFocusable = true
        b.isFocusableInTouchMode = true
        b.setOnFocusChangeListener { _, has ->
            if (has) {
                b.background = roundBg(C_FOCUS, 0xFFFFFFFF.toInt(), 2)
                b.setTextColor(Color.WHITE)
                b.scaleX = 1.06f; b.scaleY = 1.06f
            } else {
                b.background = roundBg(C_CARD2, 0xFF3A3F52.toInt(), 1)
                b.setTextColor(C_TXT)
                b.scaleX = 1f; b.scaleY = 1f
            }
        }
        return b
    }

    private fun hintRow(text: String): TextView {
        val tv = TextView(this)
        tv.text = text
        tv.textSize = 15f
        tv.setTextColor(C_MUT)
        tv.setPadding(dp(20), dp(40), dp(20), dp(40))
        tv.gravity = Gravity.CENTER
        return tv
    }

    /**
     * 歌曲行（参考手绘稿分色）：序号红 / 歌名白 / 歌手青 / 类型蓝 / 语种粉
     * 四种状态一眼分清：
     *   未选中   深底灰描边
     *   选中     整行亮红底 + 白描边 + 歌名变白加大
     *   已点     行尾「✓ 已点」绿底 + 行号变绿
     *   正在播放 歌名金色加「●」+ 行号金色 + 行尾「● 演唱中」金底
     */
    private fun addSongRow(song: JSONObject, no: Int) {
        val id = song.optString("id")
        val title = song.optString("title")
        val artist = song.optString("artist")
        val lang = song.optString("lang", "")
        val ty = song.optString("type", "")
        val plays = song.optInt("plays", 0)
        val isNow = id == currentSongId
        val queued = queueIndexOf(id) >= 0

        val row = LinearLayout(this)
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL
        row.setPadding(dp(14), dp(12), dp(12), dp(12))
        row.background = roundBg(C_CARD, 0xFF2A2F3D.toInt(), 1)
        row.layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { setMargins(0, 0, 0, dp(8)) }
        // 行本身不抢焦点：遥控器光标落在「点歌」按钮上，向左一步就是「收藏」
        row.isFocusable = false
        row.isClickable = false
        // 行高亮跟随行内按钮的焦点（选中=整行亮红描边）
        fun paintRow(on: Boolean) {
            row.background = roundBg(
                if (on) 0xFF5A1F30.toInt() else C_CARD,
                if (on) 0xFFFFFFFF.toInt() else 0xFF2A2F3D.toInt(),
                if (on) 2 else 1
            )
        }

        // 序号（手绘稿：红色数字；已点=绿、演唱中=金）
        val idx = TextView(this)
        idx.text = "$no."
        idx.textSize = 16f
        idx.typeface = Typeface.DEFAULT_BOLD
        idx.width = dp(46)
        idx.setTextColor(when {
            isNow -> C_GOLD
            queued -> C_OK
            else -> C_ACC
        })
        row.addView(idx)

        // 歌名（演唱中前面加金色圆点）
        val tvTitle = TextView(this)
        tvTitle.text = if (isNow) "● $title" else title
        tvTitle.textSize = 17f
        tvTitle.typeface = Typeface.DEFAULT_BOLD
        tvTitle.setTextColor(if (isNow) C_GOLD else Color.WHITE)
        tvTitle.isSingleLine = true
        tvTitle.ellipsize = android.text.TextUtils.TruncateAt.END

        // 副行：歌手(青) · 类型(蓝) · 语种(粉) · 热度(灰)，分色参考手绘稿
        val meta = LinearLayout(this)
        meta.orientation = LinearLayout.HORIZONTAL
        meta.gravity = Gravity.CENTER_VERTICAL
        fun seg(text: String, color: Int) {
            if (text.isEmpty()) return
            val t = TextView(this)
            t.text = text
            t.textSize = 13f
            t.setTextColor(color)
            meta.addView(t)
        }
        seg(artist, C_ARTIST)
        seg(if (ty.isEmpty()) "" else " · $ty", C_TYPE)
        seg(if (lang.isEmpty()) "" else " · $lang", C_LANG)
        seg(if (plays >= 3) " · 🔥$plays" else "", C_MUT)
        val mid = LinearLayout(this)
        mid.orientation = LinearLayout.VERTICAL
        mid.addView(tvTitle)
        mid.addView(meta)
        mid.layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        row.addView(mid)

        // 收藏按钮：与「点歌」同高同大小，光标可到达（点歌按钮向左一步）
        val fav = Button(this)
        paintFav(fav, id)
        fav.isAllCaps = false
        fav.minWidth = 0
        fav.minimumWidth = 0
        fav.isFocusable = true
        fav.isFocusableInTouchMode = true
        favButtons[id] = fav
        fav.setOnFocusChangeListener { _, has ->
            if (has) {
                paintRow(true)
                fav.background = roundBg(C_FOCUS, 0xFFFFFFFF.toInt(), 2)
                fav.setTextColor(Color.WHITE)
                fav.scaleX = 1.08f; fav.scaleY = 1.08f
            } else {
                paintRow(false)
                paintFav(fav, id)
                fav.scaleX = 1f; fav.scaleY = 1f
            }
        }
        fav.setOnClickListener {
            Thread {
                post("/api/favs/toggle", """{"songId":"$id"}""")
                main.post {
                    val body = get("/api/state")
                    if (body != null) {
                        val favs = JSONObject(body).optJSONArray("favIds") ?: JSONArray()
                        val set = HashSet<String>()
                        for (i in 0 until favs.length()) set.add(favs.optString(i))
                        favIds = set
                    }
                    paintFav(fav, id)
                    currentIsFav = favIds.contains(currentSongId)
                    applyFavStyle()
                }
            }.start()
        }
        row.addView(fav)

        val add = Button(this)
        applyOrderStyle(add, id, ::paintRow)
        orderButtons[id] = add
        add.setOnClickListener { orderSong(id) }
        row.addView(add)

        listContainer.addView(row)
    }

    /** 收藏按钮两种状态：已收藏=红底白心，未收藏=深底灰心（尺寸与「点歌」一致） */
    private fun paintFav(b: Button, id: String) {
        val on = favIds.contains(id)
        b.text = if (on) "♥" else "♡"
        b.textSize = 17f
        b.typeface = Typeface.DEFAULT_BOLD
        b.setPadding(dp(14), dp(7), dp(14), dp(7))
        b.background = roundBg(if (on) C_ACC else C_CARD2, if (on) C_ACC else 0xFF3A3F52.toInt(), 1)
        b.setTextColor(if (on) Color.WHITE else C_MUT)
    }

    /** 点过歌的按钮要变成明显不同的颜色（绿底），一眼看出"这首已经点了" */
    private fun applyOrderStyle(b: Button, id: String, paintRow: ((Boolean) -> Unit)? = null) {
        paintOrder(b, id)
        if (b.tag != "bound") {
            b.tag = "bound"
            b.isFocusable = true
            b.isFocusableInTouchMode = true
            b.setOnFocusChangeListener { _, has ->
                if (has) {
                    paintRow?.invoke(true)
                    b.background = roundBg(C_FOCUS, 0xFFFFFFFF.toInt(), 2)
                    b.setTextColor(Color.WHITE)
                    b.scaleX = 1.08f; b.scaleY = 1.08f
                } else {
                    paintRow?.invoke(false)
                    paintOrder(b, id)
                    b.scaleX = 1f; b.scaleY = 1f
                }
            }
        }
    }

    private fun paintOrder(b: Button, id: String) {
        val queued = queueIndexOf(id) >= 0
        val isNow = id == currentSongId
        b.isAllCaps = false
        b.textSize = 13f
        b.typeface = Typeface.DEFAULT_BOLD
        b.setPadding(dp(14), dp(7), dp(14), dp(7))
        when {
            queued -> {
                b.text = "✓ 已点"
                b.background = roundBg(0xFF12351F.toInt(), C_OK, 1)
                b.setTextColor(C_OK)
            }
            isNow -> {
                b.text = "● 演唱中"
                b.background = roundBg(0xFF3A2A10.toInt(), C_GOLD, 1)
                b.setTextColor(C_GOLD)
            }
            else -> {
                b.text = "点歌"
                b.background = roundBg(C_ACC, C_ACC, 0)
                b.setTextColor(Color.WHITE)
            }
        }
    }

    private fun queueIndexOf(id: String): Int {
        for (i in 0 until lastQueue.length()) {
            val it = lastQueue.optJSONObject(i) ?: continue
            if (it.optJSONObject("song")?.optString("id") == id) return i
        }
        return -1
    }

    /** 状态变化后把所有"点歌/收藏"按钮刷成最新状态 */
    private fun refreshOrderButtons() {
        orderButtons.forEach { (id, b) -> applyOrderStyle(b, id) }
        favButtons.forEach { (id, b) -> paintFav(b, id) }
    }

    /** 列表刷新后把光标放到第一行的「点歌」按钮上 */
    private fun focusFirstOrderButton() {
        main.post {
            val first = listContainer.getChildAt(0) as? LinearLayout ?: return@post
            (first.getChildAt(first.childCount - 1) as? Button)?.requestFocus()
        }
    }

    private fun addArtistRow(artist: JSONObject) {
        val name = artist.optString("name")
        val id = artist.optString("id")
        val count = artist.optInt("count", 0)
        val reg = artist.optString("region", "")
        val gen = artist.optString("gender", "")

        val row = LinearLayout(this)
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL
        row.setPadding(dp(16), dp(14), dp(16), dp(14))
        row.background = roundBg(C_CARD, 0xFF2A2F3D.toInt(), 1)
        row.layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply { setMargins(0, 0, 0, dp(8)) }
        row.isFocusable = true
        row.isClickable = true
        row.setOnFocusChangeListener { _, hasFocus ->
            row.background = roundBg(
                if (hasFocus) 0xFF5A1F30.toInt() else C_CARD,
                if (hasFocus) 0xFFFFFFFF.toInt() else 0xFF2A2F3D.toInt(),
                if (hasFocus) 2 else 1
            )
        }
        row.setOnClickListener {
            artistName = name
            tab = Tab.SONGS
            refreshBrowser()
        }

        val iv = ImageView(this)
        iv.layoutParams = LinearLayout.LayoutParams(dp(76), dp(76)).apply { rightMargin = dp(14) }
        iv.scaleType = ImageView.ScaleType.CENTER_CROP
        iv.setBackgroundColor(C_CARD2)
        Thread {
            val bmp = loadBitmap("/api/artists/$id/avatar")
            if (bmp != null) main.post { iv.setImageBitmap(bmp) }
        }.start()
        row.addView(iv)

        val tv = TextView(this)
        val meta = listOf(reg, gen).filter { it.isNotEmpty() }.joinToString(" · ")
        tv.text = "$name" + (if (meta.isNotEmpty()) " ｜ $meta" else "") + " ｜ ${count}首"
        tv.textSize = 16f
        tv.setTextColor(Color.WHITE)
        tv.layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        row.addView(tv)

        listContainer.addView(row)
    }

    private fun orderSong(id: String) {
        Thread {
            val ok = post("/api/queue", """{"songId":"$id","by":"遥控"}""")
            main.post {
                if (ok) {
                    toastMsg("已点歌 ✅")
                    refreshOrderButtons()
                } else {
                    toastMsg("这首已经在已点列表里了")
                }
            }
        }.start()
    }

    /* ---------------- 二维码 ---------------- */

    private fun renderQr() {
        try {
            val text = "$serverBase/m/"
            val hints = mapOf(EncodeHintType.MARGIN to 1, EncodeHintType.CHARACTER_SET to "UTF-8")
            val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 600, 600, hints)
            val bmp = Bitmap.createBitmap(matrix.width, matrix.height, Bitmap.Config.RGB_565)
            for (x in 0 until matrix.width) {
                for (y in 0 until matrix.height) {
                    bmp.setPixel(x, y, if (matrix[x, y]) 0xFF111111.toInt() else 0xFFFFFFFF.toInt())
                }
            }
            qrBig.setImageBitmap(bmp)
            qrSide.setImageBitmap(bmp)
            findViewById<TextView>(R.id.idleRoom).text = getString(R.string.app_name)
        } catch (_: Exception) {
        }
    }

    /* ---------------- HTTP ---------------- */

    private fun post(path: String, body: String? = null): Boolean {
        return try {
            val json = "application/json; charset=utf-8".toMediaType()
            val req = Request.Builder().url(serverBase + path)
                .post((body ?: "{}").toRequestBody(json))
                .build()
            http.newCall(req).execute().use { it.isSuccessful }
        } catch (e: Exception) {
            false
        }
    }

    private fun get(path: String): String? {
        return try {
            val req = Request.Builder().url(serverBase + path).build()
            http.newCall(req).execute().use { resp ->
                if (resp.isSuccessful) resp.body?.string() else null
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun songListOf(path: String): JSONArray {
        return JSONObject(get(path) ?: "{}").optJSONArray("items") ?: JSONArray()
    }

    private fun loadBitmap(path: String): Bitmap? {
        return try {
            val req = Request.Builder().url(serverBase + path).build()
            http.newCall(req).execute().use { resp ->
                if (resp.isSuccessful) resp.body?.byteStream()?.use { android.graphics.BitmapFactory.decodeStream(it) } else null
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun headCode(url: String): Int {
        return try {
            val req = Request.Builder().url(serverBase + url).head().build()
            http.newCall(req).execute().use { it.code }
        } catch (e: Exception) {
            -1
        }
    }

    private fun urlencode(v: String): String = java.net.URLEncoder.encode(v, "UTF-8")

    private fun toastMsg(text: String) {
        Toast.makeText(this, text, Toast.LENGTH_SHORT).show()
    }

    override fun onDestroy() {
        super.onDestroy()
        player.release()
    }
}

/** LinearLayout.forEach 扩展（避免依赖 androidx core ktx） */
private inline fun android.view.ViewGroup.forEach(action: (View) -> Unit) {
    for (i in 0 until childCount) action(getChildAt(i))
}
