import { prisma } from '../db/prisma.js'

export async function seedCourses() {
  const existing = await prisma.course.count()
  if (existing > 0) {
    console.log('📚 Courses already seeded')
    return
  }

  const courses = [
    {
      slug: 'intro-to-ai',
      title: 'Introduction to AI',
      description: 'Learn the fundamentals of artificial intelligence: what it is, how it works, and why it matters for Africa.',
      level: 'beginner',
      priceNGN: 0,
      duration: 90,
      status: 'published',
      lessons: [
        { order: 1, title: 'What is AI?', content: 'Artificial Intelligence is the simulation of human intelligence by machines. In this lesson, we explore the history and core concepts...', duration: 15 },
        { order: 2, title: 'Types of AI', content: 'Narrow AI vs General AI vs Superintelligence. Most modern AI is narrow AI...', duration: 20 },
        { order: 3, title: 'AI in Africa', content: 'From Lagos to Nairobi, AI is transforming African industries. Learn about the unique opportunities and challenges...', duration: 25 },
        { order: 4, title: 'Getting Started', content: 'How to use VoltCore to run your first AI model. Sign up, top up your wallet, and use our API...', duration: 30 }
      ]
    },
    {
      slug: 'building-chatbots',
      title: 'Building AI Chatbots with Micro-GPT',
      description: 'Deploy your first customer service chatbot using VoltCore Micro-GPT. Real-world examples from Nigerian businesses.',
      level: 'intermediate',
      priceNGN: 5000,
      duration: 180,
      status: 'published',
      lessons: [
        { order: 1, title: 'Chatbot Basics', content: 'How do chatbots work? Intent recognition, entity extraction, response generation...', duration: 25 },
        { order: 2, title: 'Fine-tuning Micro-GPT', content: 'Upload your dataset, fine-tune the model, and deploy your custom chatbot...', duration: 45 },
        { order: 3, title: 'Deploying on WhatsApp', content: 'Connect your chatbot to WhatsApp Business API. Handle real customer queries...', duration: 55 },
        { order: 4, title: 'Monitoring & Improving', content: 'Track usage, collect feedback, and improve your chatbot over time...', duration: 55 }
      ]
    },
    {
      slug: 'gpu-compute-africa',
      title: 'GPU Compute for African Developers',
      description: 'Master VoltCore GPU compute. Run training jobs, deploy inference endpoints, and scale AI workloads in Naira.',
      level: 'intermediate',
      priceNGN: 10000,
      duration: 240,
      status: 'published',
      lessons: [
        { order: 1, title: 'Why GPUs?', content: 'CPUs vs GPUs. When to use GPU compute. Real examples of AI workloads...', duration: 30 },
        { order: 2, title: 'Provisioning GPUs', content: 'Use VoltCore to rent RTX 3090, 4090, A100. Understand pricing and availability...', duration: 40 },
        { order: 3, title: 'Training Models', content: 'Upload your training script. Monitor job progress. Download trained models...', duration: 60 },
        { order: 4, title: 'Cost Optimisation', content: 'Use spot instances, batch processing, and cheapest-first routing to minimise costs...', duration: 50 },
        { order: 5, title: 'Scaling & Production', content: 'Deploy trained models as production inference endpoints. Handle traffic...', duration: 60 }
      ]
    }
  ]

  for (const courseData of courses) {
    const { lessons, ...course } = courseData
    const created = await prisma.course.create({ data: course })
    for (const lesson of lessons) {
      await prisma.lesson.create({ data: { ...lesson, courseId: created.id } })
    }
    console.log(`📚 Course created: ${created.title} (${lessons.length} lessons)`)
  }

  console.log('✅ Courses seeded')
}