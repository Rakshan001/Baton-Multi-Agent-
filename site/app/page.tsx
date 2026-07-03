import Nav from "@/components/Nav";
import Hero from "@/components/Hero";
import Problem from "@/components/Problem";
import HowItWorks from "@/components/HowItWorks";
import Features from "@/components/Features";
import BuiltHonest from "@/components/BuiltHonest";
import DashboardShowcase from "@/components/DashboardShowcase";
import OpenSourceCTA from "@/components/OpenSourceCTA";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <>
      <Nav />
      <main id="main">
        <Hero />
        <Problem />
        <HowItWorks />
        <Features />
        <BuiltHonest />
        <DashboardShowcase />
        <OpenSourceCTA />
      </main>
      <Footer />
    </>
  );
}
