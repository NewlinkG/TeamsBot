import { useState, useEffect } from "react";
import { tasks, app } from "@microsoft/teams-js";

export default function CommentModal() {
  const [comment, setComment] = useState("");
  const [ticketId, setTicketId] = useState(null);
  const [isClose, setIsClose] = useState(false);

  useEffect(() => {
    app.initialize().then(() => {
      const hash = window.location.hash;
      const queryString = hash.includes('?') ? hash.split('?')[1] : '';
      const urlParams = new URLSearchParams(queryString);

      app.getContext().then((context) => {
        console.log("🧠 Teams context:", context);
      });

      setTicketId(urlParams.get("ticketId"));
      setIsClose(urlParams.get("isClose") === "true");
      console.log("🟢 Initialized with:", {
        ticketId: urlParams.get("ticketId"),
        isClose: urlParams.get("isClose")
      });
    });
  }, []);

  const submitComment = () => {
    console.log("🟢 Submit clicked", { ticketId, comment, isClose });
    try {
      tasks.submitTask({
        ticketId,
        comment,
        isClose
    });
    console.log("✅ Task submit executed");
    } catch (err) {
      console.error("❌ Task submit failed:", err);
    }
  };

  if (!ticketId) return <p>Loading ticket...</p>;

  return (
    <div style={{ padding: "1rem", fontFamily: "Segoe UI" }}>
      <h3>{isClose ? "Close Ticket" : "Add Comment"} #{ticketId}</h3>
      <textarea
        autoFocus
        style={{ width: "100%", height: "120px" }}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Please add a comment..."
      />
      <br />
      <button onClick={submitComment}>Enviar</button>
    </div>
  );
}
