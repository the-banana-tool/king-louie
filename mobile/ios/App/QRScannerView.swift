import AVFoundation
import SwiftUI
import UIKit

/// Camera QR scanning with AVFoundation (.qr metadata only).
struct QRScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onCode = onCode
        return controller
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {}

    final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onCode: ((String) -> Void)?
        private let session = AVCaptureSession()
        /// startRunning and stopRunning block, so they run here, in order,
        /// never on the main thread.
        private let sessionQueue = DispatchQueue(label: "kl.qr-scanner.session")
        private var preview: AVCaptureVideoPreviewLayer?
        private var delivered = false

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            guard let camera = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: camera),
                  session.canAddInput(input) else { return }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            layer.frame = view.layer.bounds
            view.layer.addSublayer(layer)
            preview = layer
            sessionQueue.async { [session] in session.startRunning() }
        }

        /// SwiftUI sizes the view after viewDidLoad; keep the preview filling it.
        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            preview?.frame = view.layer.bounds
        }

        private func stop() {
            sessionQueue.async { [session] in session.stopRunning() }
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            stop()
        }

        func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
            guard !delivered, let code = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue else { return }
            delivered = true
            stop()
            onCode?(code)
        }
    }
}
