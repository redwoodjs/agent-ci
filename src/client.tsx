import { initClientNavigation } from "rwsdk/client";
import { initRealtimeClient } from "rwsdk/realtime/client";

initRealtimeClient({
  key: window.location.pathname,
});

//initClientNavigation();
