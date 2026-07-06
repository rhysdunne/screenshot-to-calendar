import Foundation

enum APIError: LocalizedError {
    case unauthorized(code: String?)
    case server(status: Int, message: String)
    case decoding(Error)

    var errorDescription: String? {
        switch self {
        case .unauthorized: return "Please sign in again."
        case let .server(_, message): return message
        case .decoding: return "Unexpected response from the server."
        }
    }
}

/// Thin async client for the backend API (contracts in docs/architecture.md).
struct APIClient {
    var baseURL: URL = AppConfig.apiBase
    var tokenProvider: () -> String? = { KeychainStore.token }

    private func request(_ method: String, _ path: String, body: Encodable? = nil) throws -> URLRequest {
        var req = URLRequest(url: baseURL.appending(path: path))
        req.httpMethod = method
        if let token = tokenProvider() {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(body)
        }
        return req
    }

    private func send<T: Decodable>(_ req: URLRequest) async throws -> T {
        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let body = try? JSONDecoder().decode(APIErrorBody.self, from: data)
            if status == 401 { throw APIError.unauthorized(code: body?.code) }
            throw APIError.server(status: status, message: body?.error ?? "HTTP \(status)")
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.decoding(error)
        }
    }

    // MARK: Auth

    func signIn(serverAuthCode: String) async throws -> AuthResponse {
        try await send(try request("POST", "/v1/auth/google", body: ["serverAuthCode": serverAuthCode]))
    }

    // MARK: Captures

    func createCapture(imageBase64: String) async throws -> CreateCaptureResponse {
        try await send(try request("POST", "/v1/captures", body: ["imageBase64": imageBase64]))
    }

    func listCaptures() async throws -> CaptureListResponse {
        try await send(try request("GET", "/v1/captures"))
    }

    func getCapture(id: String) async throws -> Capture {
        try await send(try request("GET", "/v1/captures/\(id)"))
    }

    func imageUrl(id: String) async throws -> ImageUrlResponse {
        try await send(try request("GET", "/v1/captures/\(id)/image"))
    }

    /// Corrections: only send the fields that changed; empty string clears a field.
    func updateCapture(id: String, fields: [String: String?]) async throws -> Capture {
        try await send(try request("PATCH", "/v1/captures/\(id)", body: fields.mapValues { $0 ?? "" }))
    }

    func deleteCapture(id: String, deleteEvent: Bool) async throws {
        let _: [String: Bool] = try await send(
            try request("DELETE", "/v1/captures/\(id)?deleteEvent=\(deleteEvent)"))
    }

    // MARK: Calendars & settings

    func listCalendars() async throws -> CalendarListResponse {
        try await send(try request("GET", "/v1/calendars"))
    }

    func createCalendar(summary: String) async throws -> CalendarEntry {
        try await send(try request("POST", "/v1/calendars", body: ["summary": summary]))
    }

    func getSettings() async throws -> UserSettings {
        try await send(try request("GET", "/v1/settings"))
    }

    func updateSettings(_ settings: UserSettings) async throws -> UserSettings {
        try await send(try request("PUT", "/v1/settings", body: settings))
    }

    // MARK: GDPR

    func exportAccount() async throws -> ExportResponse {
        try await send(try request("POST", "/v1/account/export"))
    }

    func deleteAccount() async throws {
        let _: [String: Bool] = try await send(try request("DELETE", "/v1/account"))
    }
}
