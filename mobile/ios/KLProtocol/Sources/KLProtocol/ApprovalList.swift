import Foundation

/// The rows for what a pinned node signed that this phone cannot read or may not
/// answer (sealed phones plan, R-SP-6, R-SP-15), as ApprovalList.kt builds them.
/// iOS draws its other lists screen by screen, so this holds this one kind alone.
/// `Button` has no cases: no row built here can offer a decision.
public enum ApprovalList {
    public enum Kind: Equatable {
        case unreadable
    }

    public enum Button: Equatable {}

    /// One message that cannot be read, in the app's words. `ref` is unique across
    /// kinds (the kind's prefix and its own id). `timeLeftMs` nil: it has no deadline.
    public struct SealedUnreadable: Equatable {
        public let ref: String
        public let nodeId: String
        public let nodeName: String
        public let label: String
        public let line: String
        public let timeLeftMs: Int64?

        public init(ref: String, nodeId: String, nodeName: String, label: String, line: String, timeLeftMs: Int64? = nil) {
            self.ref = ref
            self.nodeId = nodeId
            self.nodeName = nodeName
            self.label = label
            self.line = line
            self.timeLeftMs = timeLeftMs
        }
    }

    public struct Row: Equatable, Identifiable {
        public let id: String
        public let kind: Kind
        public let ref: String
        public let nodeId: String
        public let nodeName: String
        public let label: String
        public let cardLines: [String]
        public let timeLeftMs: Int64?
        public let buttons: [Button]
        public let enabled: Bool
        public let warning: Bool
        public let hasDetail: Bool
    }

    /// The soonest deadline first; those with no deadline last, in the order given.
    public static func build(sealedUnreadable: [SealedUnreadable]) -> [Row] {
        sealedUnreadable.enumerated()
            .sorted { a, b in
                let left = a.element.timeLeftMs ?? Int64.max
                let right = b.element.timeLeftMs ?? Int64.max
                return left == right ? a.offset < b.offset : left < right
            }
            .map { sealedRow($0.element) }
    }

    private static func sealedRow(_ u: SealedUnreadable) -> Row {
        Row(id: "sealed:\(u.ref)", kind: .unreadable, ref: u.ref, nodeId: u.nodeId, nodeName: Display.escape(u.nodeName),
            label: u.label, cardLines: [Display.escape(u.line)], timeLeftMs: u.timeLeftMs.map { max($0, 0) },
            buttons: [], enabled: false, warning: true, hasDetail: false)
    }
}
