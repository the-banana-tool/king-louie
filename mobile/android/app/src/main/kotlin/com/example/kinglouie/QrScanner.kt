package com.example.kinglouie

import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.google.zxing.BinaryBitmap
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** CameraX preview with ZXing decoding QR codes from the luminance plane, off the main thread. */
@Composable
fun QrScanner(modifier: Modifier = Modifier, onCode: (String) -> Unit) {
    val context = LocalContext.current
    val bound = remember { AtomicReference<ProcessCameraProvider?>(null) }
    val analyzer = remember { Executors.newSingleThreadExecutor() }
    DisposableEffect(Unit) {
        onDispose {
            bound.getAndSet(null)?.unbindAll()
            analyzer.shutdown()
        }
    }
    AndroidView(modifier = modifier, factory = { ctx ->
        val view = PreviewView(ctx)
        val main = ContextCompat.getMainExecutor(ctx)
        val providerFuture = ProcessCameraProvider.getInstance(ctx)
        providerFuture.addListener({
            val provider = providerFuture.get()
            val preview = Preview.Builder().build().also { it.setSurfaceProvider(view.surfaceProvider) }
            val delivered = AtomicBoolean(false)
            val reader = QRCodeReader()
            val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
            analysis.setAnalyzer(analyzer) { image ->
                try {
                    if (!delivered.get()) {
                        val plane = image.planes[0]
                        val bytes = ByteArray(plane.buffer.remaining()).also { plane.buffer.get(it) }
                        val source = PlanarYUVLuminanceSource(bytes, plane.rowStride, image.height, 0, 0, image.width, image.height, false)
                        val text = runCatching { reader.decode(BinaryBitmap(HybridBinarizer(source))).text }.getOrNull()
                        if (text != null && delivered.compareAndSet(false, true)) {
                            main.execute {
                                bound.getAndSet(null)?.unbindAll()
                                onCode(text)
                            }
                        }
                    }
                } finally {
                    image.close()
                }
            }
            provider.unbindAll()
            // Without camera permission this fails; the paste field still works.
            runCatching {
                provider.bindToLifecycle(context as LifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                bound.set(provider)
            }
        }, main)
        view
    })
}
