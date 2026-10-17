import Foundation
import Testing

@Suite("APIURL")
struct APIURLTests {
    let base = URL(string: "https://api.example.com")!

    // The backend reads deleteEvent from queryStringParameters. A "?" put in
    // the path is percent-encoded, so the route 404s and the flag is lost.
    @Test("Query items go in the query, not the path")
    func query() {
        let url = APIURL.make(
            base, path: "/v1/captures/01ABC",
            query: [URLQueryItem(name: "deleteEvent", value: "true")])
        #expect(url.absoluteString == "https://api.example.com/v1/captures/01ABC?deleteEvent=true")
        #expect(url.path == "/v1/captures/01ABC")
        #expect(url.query == "deleteEvent=true")
    }

    @Test("A URL with no query items has no trailing question mark")
    func noQuery() {
        let url = APIURL.make(base, path: "/v1/captures")
        #expect(url.absoluteString == "https://api.example.com/v1/captures")
        #expect(url.query == nil)
    }
}
