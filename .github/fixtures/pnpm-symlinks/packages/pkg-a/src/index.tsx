import React from "react";
import { doStuff } from "my-untyped-lib";

// Exercises @types/react resolution (issue #176)
export const App: React.FC = () => <div>{doStuff()}</div>;
