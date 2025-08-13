This is an interrupter. It tries to determine whether the container is up and running. I try to make it incredibly flexible, but it feels somewhat convoluted and complicated.

So what happens is it checks to see if the container is up and running. There are really three things that we are trying to understand if it is up and running:

1. The bootstrap command has run
2. The long-running process is currently running
3. To determine if the ports are open.

Neither of those things will actually guarantee that the long-running process is working and that you can actually connect to it. So I need to somewhat manage the expectation of the user here. But I think I can do that at a later stage. I think simply having the software installed, the machine up and running, and it has the ability to potentially accept HTTP connections is probably good enough.

The big issue is that I need to figure out when the long-running process is ready to accept connections.

Okay, so let's work on actual use cases. When do you want a container to be up and running?

1. You want to connect to the container with the terminal.
2. You want to open the web page that is being served by the long-running process.
3. You want to read the logs
4. You want to modify the files.
