package com.example.kinglouie

import android.Manifest
import android.content.Intent
import android.os.Bundle
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.graphics.toArgb
import androidx.fragment.app.FragmentActivity
import com.example.kinglouie.push.Push

class MainActivity : FragmentActivity() {
    private lateinit var model: AppModel

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        model = (application as KingLouieApplication).model
        model.activity = this
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {}
            .launch(arrayOf(Manifest.permission.CAMERA, Manifest.permission.POST_NOTIFICATIONS))
        if (Push.ENABLED) Push.register(this) { token -> model.registerPushToken(token) }
        // Drawn behind the status and navigation bars; every screen pads itself by their insets.
        // The app is dark only: light bar icons over bgSidebarHdr whatever the system setting.
        val bars = SystemBarStyle.dark(KlTokens.bgSidebarHdr.toArgb())
        enableEdgeToEdge(statusBarStyle = bars, navigationBarStyle = bars)
        setContent { KingLouieTheme { Root(model) } }
        handle(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    override fun onDestroy() {
        if (model.activity === this) model.activity = null
        super.onDestroy()
    }

    /**
     * A tapped notification carries only a kind, an id and the running count
     * (android-slim §13, push spec §7.2): AppModel.openPushed opens the list
     * for a count above 1 or a test; otherwise it fetches with the read key,
     * verifies, and selects that item's detail, or opens the list with "That
     * request is no longer waiting." when it is gone.
     */
    private fun handle(intent: Intent?) {
        val id = intent?.getStringExtra(Push.EXTRA_REQUEST_ID) ?: return
        model.openPushed(intent.getStringExtra(Push.EXTRA_KIND) ?: "approval", id, intent.getIntExtra(Push.EXTRA_COUNT, 1))
    }
}
