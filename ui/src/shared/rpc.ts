export type MyRPCSchema = {
  bun: {
    requests: {
      selectRepo: {
        params: void;
        response: string | null;
      };
    };
    messages: {};
  };
  webview: {
    requests: {};
    messages: {
      dtuLog: string;
    };
  };
};
