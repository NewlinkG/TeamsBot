import { useState, useEffect } from "react";
import { dialog } from "@microsoft/teams-js";

export default function CommentModal() {
  const [comment, setComment] = useState("");
  const [ticketId, setTicketId] = useState(null);
  const [isClose, setIsClose] = useState(false);

  useEffect(() => {
    const hash = window.location.hash;
    console.log("🚀 Full hash:", hash); // debug line

    const queryString = hash.includes('?') ? hash.split('?')[1] : '';
    console.log("🔍 Query string:", queryString); // debug line

    const urlParams = new URLSearchParams(queryString);
    console.log("✅ ticketId:", urlParams.get("ticketId")); // debug line

    setTicketId(urlParams.get("ticketId"));
    setIsClose(urlParams.get("isClose") === "true");
  }, []);


  const submitComment = () => {
    dialog.url.submit({ ticketId, comment, isClose });
  };

  if (!ticketId) return <p>Loading ticket...</p>;

  return (
    <div style={{ padding: "1rem", fontFamily: "Segoe UI" }}>
      <h3>{isClose ? "Cerrar Ticket" : "Agregar Comentario"} #{ticketId}</h3>
      <textarea
        style={{ width: "100%", height: "120px" }}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Escribí tu comentario..."
      />
      <br />
      <button onClick={submitComment}>Enviar</button>
    </div>
  );
}
