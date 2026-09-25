// swift-tools-version:5.9
// The approval-v1 protocol core shared by the iOS app. System frameworks only
// (Foundation, CryptoKit); the tests read ../../../tests/vectors/approval-v1.
import PackageDescription

let package = Package(
    name: "KLProtocol",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "KLProtocol", targets: ["KLProtocol"])
    ],
    targets: [
        .target(name: "KLProtocol"),
        .testTarget(name: "KLProtocolTests", dependencies: ["KLProtocol"])
    ]
)
