import { route } from "rwsdk/router";
import { Blog, BlogPost } from "./pages";

export const blogRoutes = [route("/", Blog), route("/:slug", BlogPost)];
