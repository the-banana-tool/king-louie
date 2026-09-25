package com.example.kinglouie

import android.app.Application

/** Holds the one AppModel, so it outlives activity recreation. */
class KingLouieApplication : Application() {
    lateinit var model: AppModel
        private set

    override fun onCreate() {
        super.onCreate()
        model = AppModel(this)
    }
}
