export const Heading = ({ children }: { children: React.ReactNode }) => {
  return (
    <h2 className="text-3xl font-bold font-advercase border-b p-4">
      {children}
    </h2>
  );
};
