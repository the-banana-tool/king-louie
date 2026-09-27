package com.example.kinglouie

import android.Manifest
import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
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
        setContent { Root(model) }
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

    /** A tapped notification carries only a kind and an id; the app fetches and verifies. */
    private fun handle(intent: Intent?) {
        val id = intent?.getStringExtra(Push.EXTRA_REQUEST_ID) ?: return
        model.openPushed(intent.getStringExtra(Push.EXTRA_KIND) ?: "approval", id)
    }
}
